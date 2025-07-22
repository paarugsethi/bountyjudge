const fs = require('fs');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const FirecrawlApp = require('@mendable/firecrawl-js').default;
require('dotenv').config();

// Initialize Firecrawl
const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const MAX_CONCURRENT = 2; // Firecrawl rate limit
const RETRY_ATTEMPTS = 2;

// Normalize link to include https if missing and fix Substack URLs
function normalizeLink(link) {
  if (!link) return '';
  let normalized = link.trim();
  if (!normalized.startsWith('http')) {
    normalized = 'https://' + normalized;
  }
  
  // Fix Substack URLs - convert open.substack.com to direct publication URLs
  if (normalized.includes('open.substack.com')) {
    // Extract publication name and post slug from the URL
    // Pattern: https://open.substack.com/pub/PUBNAME/p/POSTSLUG?...
    const pubMatch = normalized.match(/pub\/([^\/]+)\/p\/([^?]+)/);
    if (pubMatch) {
      const pubName = pubMatch[1];
      const postSlug = pubMatch[2];
      normalized = `https://${pubName}.substack.com/p/${postSlug}`;
    }
  }
  
  return normalized;
}

// Read CSV
const rows = [];

// Read full rows instead of just links
fs.createReadStream('submissions.csv')
  .pipe(csv())
  .on('data', (row) => {
    if (row['Submission Link']) {
      // Skip arena.colosseum and Twitter/X links
      if (row['Submission Link'].includes('arena.colosseum')) {
        console.log(`⏭️  Skipping arena.colosseum link: ${row.Name}`);
        return;
      }
      if (row['Submission Link'].includes('x.com') || row['Submission Link'].includes('twitter.com')) {
        console.log(`⏭️  Skipping Twitter/X link: ${row.Name}`);
        return;
      }
      // Normalize the link before storing
      row['Submission Link'] = normalizeLink(row['Submission Link']);
      rows.push(row);
    }
  })
  .on('end', async () => {
    console.log(`Found ${rows.length} submissions. Processing...`);
    
    // Ensure texts directory exists
    if (!fs.existsSync('texts')) {
      fs.mkdirSync('texts');
    }
    
    await processLinks(rows);
  });

// Load existing results using proper CSV parsing
async function loadExistingResults() {
  const results = [];
  
  try {
    if (fs.existsSync('submissions_with_wordcount.csv')) {
      console.log('📂 Loading existing results...');
      
      return new Promise((resolve) => {
        fs.createReadStream('submissions_with_wordcount.csv')
          .pipe(csv())
          .on('data', (row) => {
            if (row['Submission Link'] && row['Word Count']) {
              results.push({
                Name: row.Name,
                Email: row.Email,
                Link: row['Submission Link'],
                WordCount: parseInt(row['Word Count'], 10)
              });
            }
          })
          .on('end', () => {
            console.log(`📊 Loaded ${results.length} existing results`);
            resolve(results);
          });
      });
    } else {
      console.log('📂 Starting fresh...');
      return results;
    }
  } catch (error) {
    console.log('📂 Error loading existing results, starting fresh...');
    return results;
  }
}

// Process single submission with Firecrawl
async function processSubmissionWithFirecrawl(row, retryCount = 0) {
  const link = row['Submission Link'];
  
  try {
    // Skip Google Docs, Google Drive, and Twitter/X links  
    if (link.includes('docs.google.com') || link.includes('drive.google.com')) {
      console.log(`⏭️  Skipping Google link: ${link}`);
      return null;
    }
    if (link.includes('x.com') || link.includes('twitter.com')) {
      console.log(`⏭️  Skipping Twitter/X link: ${link}`);
      return null;
    }
    
    console.log(`🔥 Firecrawl scraping: ${link}`);
    
    // Use Firecrawl to scrape the page
    const scrapeResult = await app.scrapeUrl(normalizeLink(link), {
      formats: ['markdown'],
      timeout: 30000,
      waitFor: 2000
    });
    
    if (!scrapeResult.success) {
      throw new Error(`Firecrawl failed: ${scrapeResult.error || 'Unknown error'}`);
    }
    
    const text = scrapeResult.markdown || '';
    const wordCount = text.trim().split(/\s+/).filter(word => word.length > 0).length;
    
    console.log(`${link} — ${wordCount} words`);
    
    if (wordCount >= 2000) {
      // Save full text content to file
      const textPath = `texts/${sanitizeFilename(row['Name'])}.txt`;
      fs.writeFileSync(textPath, text);
      
      return {
        Name: row['Name'],
        Email: row['Email ID'],
        Link: normalizeLink(link),
        WordCount: wordCount
      };
    }
    
    return null;
    
  } catch (err) {
    if (retryCount < RETRY_ATTEMPTS) {
      console.log(`⚠️  Retrying ${link} (attempt ${retryCount + 1}/${RETRY_ATTEMPTS})`);
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s before retry
      return processSubmissionWithFirecrawl(row, retryCount + 1);
    }
    
    console.error(`❌ Failed to process ${link} after ${RETRY_ATTEMPTS + 1} attempts: ${err.message}`);
    return null;
  }
}


// Process submissions in batches with concurrency
async function processLinks(submissions) {
  const results = await loadExistingResults();
  const processedLinks = new Set(results.map(r => r.Link));
  
  // Filter out already processed submissions
  const toProcess = submissions.filter(row => {
    const link = normalizeLink(row['Submission Link']);
    return !processedLinks.has(link);
  });
  
  console.log(`📊 Processing ${toProcess.length} new submissions (${results.length} already completed)`);
  
  if (toProcess.length === 0) {
    console.log('✅ All submissions already processed!');
    return;
  }
  
  try {
    // Process in batches of MAX_CONCURRENT
    for (let i = 0; i < toProcess.length; i += MAX_CONCURRENT) {
      const batch = toProcess.slice(i, i + MAX_CONCURRENT);
      
      console.log(`\n🔄 Processing batch ${Math.floor(i/MAX_CONCURRENT) + 1}/${Math.ceil(toProcess.length/MAX_CONCURRENT)} (${batch.length} submissions)`);
      
      const batchPromises = batch.map(row => processSubmissionWithFirecrawl(row));
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Add successful results
      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      }
      
      // Save progress after each batch
      await saveResults(results);
      console.log(`📊 Progress: ${i + batch.length}/${toProcess.length} processed, ${results.length} qualifying submissions`);
      
      // Rate limiting delay between batches
      if (i + MAX_CONCURRENT < toProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 8000)); // Much longer delay for API respect
      }
    }
  } catch (error) {
    console.error('❌ Error during processing:', error);
  }
  
  console.log(`\n✅ Final results: ${results.length} qualifying submissions saved`);
}

// Helper function to save results
async function saveResults(results) {
  const csvWriter = createCsvWriter({
    path: 'submissions_with_wordcount.csv',
    header: [
      { id: 'Name', title: 'Name' },
      { id: 'Email', title: 'Email' },
      { id: 'Link', title: 'Submission Link' },
      { id: 'WordCount', title: 'Word Count' }
    ]
  });

  await csvWriter.writeRecords(results);
}


function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}