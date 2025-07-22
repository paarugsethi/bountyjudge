### This repo has scripts to complete two tasks:
- wordcounter.js takes submissions.csv as input, scrapes content using Firecrawl API, and outputs submissions_with_wordcount.csv containing only submissions with 2000+ words
- judge-ai.js reads the text content, filters AI-generated submissions (≥71% threshold), scores human-written submissions, and outputs RESULTS.md with rankings

**NOTE:** submissions.csv should only have Name,Submission Link,Email ID

### Setup:
1. Copy `.env.example` to `.env` 
2. Add your OpenAI API key: `OPENAI_API_KEY=sk-...`
3. Add your Firecrawl API key: `FIRECRAWL_API_KEY=fc-...`
4. Run `npm install`

### Final steps to judge bounties from Earn:
1. Export submissions as CSV from Earn
2. Import the CSV in Sheets and delete all columns except Name, Submission Link and Email ID
3. Export this Sheet as CSV (as submissions.csv) and add it to the project directory
4. Run `node wordcounter.js` (handles rate limiting, auto-skips Twitter/X links, saves text files)
5. Once submissions_with_wordcount.csv is created, run `node judge-ai.js` (AI detection → quality scoring → final rankings)

### Features:
- **Firecrawl Integration**: Reliable web scraping that handles images, dynamic content, and complex layouts
- **AI Detection**: Filters out heavily AI-generated content using GPT-4o analysis
- **Resume Functionality**: Wordcounter continues from where it left off if interrupted
- **Rate Limiting**: Respects API limits with proper delays between requests
- **Auto-Filtering**: Skips Google Docs, Google Drive, and Twitter/X links automatically
- **Comprehensive Scoring**: Evaluates against specific bounty criteria with detailed reasoning

### Output Files:
- `submissions_with_wordcount.csv` - Qualifying submissions with word counts
- `texts/` - Full extracted content for each qualifying submission
- `all_results.json` - Complete analysis data including AI detection results
- `RESULTS.md` - Final formatted rankings with detailed feedback