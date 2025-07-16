const fs = require('fs');
const csv = require('csv-parser');
const puppeteer = require('puppeteer');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;


const links = [];

// Normalize link to include https if missing
function normalizeLink(link) {
  if (!link.startsWith('http')) return 'https://' + link;
  return link;
}

// Read CSV
const rows = [];

// Read full rows instead of just links
fs.createReadStream('submissions.csv')
  .pipe(csv())
  .on('data', (row) => {
    if (row['Submission Link']) {
      // Normalize the link before storing
      row['Submission Link'] = row['Submission Link'].startsWith('http')
        ? row['Submission Link']
        : 'https://' + row['Submission Link'];
      rows.push(row);
    }
  })
  .on('end', async () => {
    console.log(`Found ${rows.length} submissions. Processing...`);
    await processLinks(rows);
  });

// Scrape text and count words
async function processLinks(links) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
  
    // Set desktop browser-like user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
    );
  
    const results = [];
  
    for (const row of links) {  // change 'links' to 'rows' above if needed
        const link = row['Submission Link'];
      try {
        await page.goto(link, { waitUntil: 'networkidle2', timeout: 90000 });
  
        // Scroll to bottom to trigger lazy load
        await autoScroll(page);
  
        // Wait for common Medium content selectors
        await page.waitForSelector('.section-inner, .n, article', { timeout: 10000 });
  
        const text = await page.evaluate(() => {
          const sectionTexts = Array.from(document.querySelectorAll('.section-inner, .n, article'))
            .map(el => el.innerText)
            .join(' ');
          return sectionTexts;
        });
  
        const wordCount = text.trim().split(/\s+/).length;

        // Save the full article text for AI judging
const filename = `texts/${row['Name'].replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`;
fs.mkdirSync('texts', { recursive: true });
fs.writeFileSync(filename, text);

        console.log(`${link} — ${wordCount} words`);
  
        if (wordCount >= 2000) {
            results.push({
                Name: row['Name'],
                Email: row['Email ID'],
                Link: link,
                WordCount: wordCount
              });
            
        }
      } catch (err) {
        console.error(`⚠️ Failed to process ${link}: ${err.message}`);
      }
    }
  
    await browser.close();
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
      console.log(`✅ Saved ${results.length} entries to submissions_with_wordcount.csv`);
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