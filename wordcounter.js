const fs = require('fs');
const csv = require('csv-parser');
const puppeteer = require('puppeteer');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const MAX_CONCURRENT = 3;
const TIMEOUT_MS = 30000;
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
      // Skip arena.colosseum links
      if (row['Submission Link'].includes('arena.colosseum')) {
        console.log(`⏭️  Skipping arena.colosseum link: ${row.Name}`);
        return;
      }
      // Normalize the link before storing
      row['Submission Link'] = normalizeLink(row['Submission Link']);
      rows.push(row);
    }
  })
  .on('end', async () => {
    console.log(`Found ${rows.length} submissions. Processing...`);
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

// Process single submission with retry logic
async function processSubmission(browser, row, retryCount = 0) {
  const link = row['Submission Link'];
  
  try {
    // Skip Google Docs and Google Drive links
    if (link.includes('docs.google.com') || link.includes('drive.google.com')) {
      console.log(`⏭️  Skipping Google link: ${link}`);
      return null;
    }
    
    const page = await browser.newPage();
    
    // Set desktop browser-like user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
    );
    
    // Navigate with timeout
    await page.goto(normalizeLink(link), { 
      waitUntil: 'networkidle2', 
      timeout: TIMEOUT_MS 
    });
    
    // Scroll to bottom to trigger lazy load
    await autoScroll(page);
    
    // Extract text based on platform
    let text = await extractText(page, link);
    
    const wordCount = text.trim().split(/\s+/).length;
    
    // Save PDF
    const filename = `pdfs/${sanitizeFilename(row['Name'])}.pdf`;
    fs.mkdirSync('pdfs', { recursive: true });
    await page.pdf({ 
      path: filename, 
      format: 'A4',
      printBackground: true,
      margin: { top: '1cm', bottom: '1cm', left: '1cm', right: '1cm' }
    });
    
    await page.close();
    
    console.log(`${link} — ${wordCount} words`);
    
    if (wordCount >= 2000) {
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
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
      return processSubmission(browser, row, retryCount + 1);
    }
    
    console.error(`❌ Failed to process ${link} after ${RETRY_ATTEMPTS + 1} attempts: ${err.message}`);
    return null;
  }
}

// Extract text based on platform
async function extractText(page, link) {
  if (link.includes('substack.com')) {
    try {
      await page.waitForSelector('.markup, .post-content, .available-content', { timeout: 5000 });
      await page.waitForTimeout(2000);
      
      return await page.evaluate(() => {
        const selectors = [
          '.markup', '.post-content', '.available-content', '.body', '.post-body',
          '[class*="markup"]', 'article .markup', '.container .markup'
        ];
        
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element && element.innerText && element.innerText.length > 100) {
            return element.innerText;
          }
        }
        
        return document.body.innerText || '';
      });
    } catch (e) {
      console.log(`⚠️  Substack fallback for ${link}`);
      return await page.evaluate(() => document.body.innerText || '');
    }
  } else if (link.includes('medium.com')) {
    try {
      await page.waitForSelector('.section-inner, .n, article', { timeout: 3000 });
      return await page.evaluate(() => {
        const sectionTexts = Array.from(document.querySelectorAll('.section-inner, .n, article'))
          .map(el => el.innerText)
          .join(' ');
        return sectionTexts;
      });
    } catch (e) {
      console.log(`⚠️  Medium fallback for ${link}`);
      return await page.evaluate(() => document.body.innerText || '');
    }
  } else {
    try {
      await page.waitForSelector('.kix-page, .doc-content, .contents', { timeout: 3000 });
      return await page.evaluate(() => {
        const content = document.querySelector('.kix-page, .doc-content, .contents');
        return content ? content.innerText : '';
      });
    } catch (e) {
      console.log(`⚠️  Using fallback selector for ${link}`);
      return await page.evaluate(() => document.body.innerText || '');
    }
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
  
  // Launch browser once
  const browser = await puppeteer.launch({ 
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  try {
    // Process in batches of MAX_CONCURRENT
    for (let i = 0; i < toProcess.length; i += MAX_CONCURRENT) {
      const batch = toProcess.slice(i, i + MAX_CONCURRENT);
      
      console.log(`\n🔄 Processing batch ${Math.floor(i/MAX_CONCURRENT) + 1}/${Math.ceil(toProcess.length/MAX_CONCURRENT)} (${batch.length} submissions)`);
      
      const batchPromises = batch.map(row => processSubmission(browser, row));
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
      
      // Small delay between batches
      if (i + MAX_CONCURRENT < toProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } finally {
    await browser.close();
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

// Scroll to bottom of page slowly to load all content
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}