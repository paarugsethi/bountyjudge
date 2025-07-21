const fs = require('fs');
const csv = require('csv-parser');
require('dotenv').config();
const OpenAI = require('openai');
const pdf = require('pdf-parse');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const rows = [];

fs.createReadStream('submissions_with_wordcount.csv')
  .pipe(csv())
  .on('data', (row) => {
    const wordCount = parseInt(row['Word Count'], 10);
    const link = row['Submission Link'];
  
    console.log(`▶️ Link: ${link} | Word Count: ${wordCount}`);
  
    if (link && wordCount >= 1000) {
      rows.push(row);
    }
  })
  .on('end', async () => {
    console.log(`📦 Found ${rows.length} eligible submissions`);
    await judgeWithAI(rows);
  });

const allResultsPath = 'all_results.json';

async function judgeWithAI(rows) {
  const results = [];
  const aiDetectionResults = [];

  // First pass: AI detection
  console.log('\n🤖 Phase 1: AI Detection Analysis');
  for (const row of rows) {
    try {
      const pdfPath = `pdfs/${sanitizeFilename(row.Name)}.pdf`;
      const pdfBuffer = fs.readFileSync(pdfPath);
      const pdfData = await pdf(pdfBuffer);
      const text = pdfData.text;
      const aiDetectionResponse = await detectAIContent(text);
      
      // Clean the response
      let cleanedResponse = aiDetectionResponse.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      }
      if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(cleanedResponse);
      } catch (e) {
        console.log(`AI Detection JSON parse error for ${row.Name}:`, cleanedResponse.substring(0, 200));
        // Default to human-written if detection fails
        parsedResponse = { aiPercentage: 20, reasoning: ['AI detection failed, defaulting to human-written'] };
      }
      
      const { aiPercentage, reasoning } = parsedResponse;
      
      aiDetectionResults.push({
        ...row,
        aiPercentage,
        aiReasoning: reasoning
      });

      const status = aiPercentage >= 71 ? '❌ REJECTED (AI)' : '✅ HUMAN';
      console.log(`${status} ${row.Name}: ${aiPercentage}% AI-generated`);
      
    } catch (err) {
      console.error(`❌ AI Detection failed for ${row.Name}: ${err.message}`);
      // Default to human-written if detection fails
      aiDetectionResults.push({
        ...row,
        aiPercentage: 20,
        aiReasoning: ['AI detection failed, defaulting to human-written']
      });
    }
  }

  // Filter out AI-generated content (>=71%)
  const humanWrittenSubmissions = aiDetectionResults.filter(row => row.aiPercentage < 71);
  const rejectedSubmissions = aiDetectionResults.filter(row => row.aiPercentage >= 71);
  
  console.log(`\n📊 AI Detection Results:`);
  console.log(`   Human-written: ${humanWrittenSubmissions.length}`);
  console.log(`   AI-generated (rejected): ${rejectedSubmissions.length}`);
  
  if (rejectedSubmissions.length > 0) {
    console.log(`\n❌ Rejected for AI content (≥71%):`);
    rejectedSubmissions.forEach(row => {
      console.log(`   ${row.Name}: ${row.aiPercentage}%`);
    });
  }

  // Second pass: Quality scoring for human-written submissions only
  console.log('\n📝 Phase 2: Quality Evaluation (Human-written only)');
  for (const row of humanWrittenSubmissions) {
    try {
      const pdfPath = `pdfs/${sanitizeFilename(row.Name)}.pdf`;
      const pdfBuffer = fs.readFileSync(pdfPath);
      const pdfData = await pdf(pdfBuffer);
      const text = pdfData.text;
      const aiResponse = await evaluateSubmission(text);
      
      // Clean the response - remove markdown code blocks if present
      let cleanedResponse = aiResponse.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      }
      if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(cleanedResponse);
      } catch (e) {
        console.log(`JSON parse error for ${row.Name}:`, cleanedResponse.substring(0, 200));
        throw new Error(`Invalid JSON response: ${e.message}`);
      }
      
      const { score, reasoning } = parsedResponse;

      results.push({
        Name: row.Name,
        Link: row['Submission Link'],
        WordCount: row['Word Count'],
        Score: score,
        Reasoning: reasoning,
        AIPercentage: row.aiPercentage,
        AIReasoning: row.aiReasoning
      });

      console.log(`✅ Scored ${row.Name}: ${score}/18 (${row.aiPercentage}% AI)`);
    } catch (err) {
      console.error(`❌ ${row.Name}: ${err.message}`);
    }
  }

  // Save all results including AI detection data
  const allResultsWithAI = {
    humanWritten: results,
    rejectedForAI: rejectedSubmissions.map(row => ({
      Name: row.Name,
      Link: row['Submission Link'],
      WordCount: row['Word Count'],
      AIPercentage: row.aiPercentage,
      AIReasoning: row.aiReasoning,
      Status: 'Rejected - AI Generated'
    }))
  };
  
  fs.writeFileSync(allResultsPath, JSON.stringify(allResultsWithAI, null, 2));
  
  if (results.length > 0) {
    runComparativeJudgment(results);
  } else {
    console.log('\n❌ No human-written submissions found for comparative judgment!');
  }
}

async function detectAIContent(text) {
  const prompt = `
You are an expert at detecting AI-generated content. Analyze this text and determine what percentage was likely written by AI vs human.

Look for these AI indicators:
- Overly formal, academic tone lacking personality
- Generic phrases like "In conclusion", "It is important to note", "Furthermore", "Moreover"
- Perfect grammar with no natural human errors or contractions
- Repetitive sentence structures
- Buzzword-heavy language without substance
- Lists that feel artificially comprehensive
- Lack of personal anecdotes, opinions, or unique voice
- Generic transitions between topics
- Overly balanced viewpoints without taking sides
- Technical explanations that feel copy-pasted
- Uniform paragraph lengths and structures

Human indicators:
- Natural conversational tone with personality
- Unique insights, personal experiences, or hot takes
- Occasional grammar imperfections or informal language
- Varied sentence lengths and structures
- Strong opinions or biases
- References to specific personal experiences
- Natural flow of thought with tangents
- Inconsistent writing style (more human)
- Colloquialisms, slang, or regional expressions

Return your analysis as JSON:
{
  "aiPercentage": percentage_0_to_100,
  "reasoning": [
    "specific evidence for AI generation",
    "specific evidence for human writing",
    "overall assessment basis"
  ]
}

Text to analyze:
"""${text.length > 8000 ? text.slice(0, 4000) + "\n...\n" + text.slice(-2000) : text}"""`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 500
  });

  if (!response || !response.choices || !response.choices.length) {
    throw new Error("Invalid or empty response from OpenAI for AI detection");
  }

  return response.choices[0].message.content;
}

async function evaluateSubmission(text, bountyDescription = null) {
  const topic = "the State of stablecoins on Solana";

  // Default RWA bounty description if none provided
  const defaultBountyDescription = `
About the Bounty
Stablecoins are a key primitive for driving both crypto-native & mainstream adoption. A quick overview of where things stand:

stablecoin supply on Solana recently crossed $10B

there were $200M monthly transactions doing over $40B in volume

companies like Stripe, Shopify, Visa, Mastercard, etc have integrated stablecoins into their products.

new startups like Squads, KAST, Perena, etc are innovating at the frontier of stablecoin based products

the recently passed GENIUS act provides a first ever framework for dollar denominated stablecoins

while USDC & USDT dominate, lots of new players like PYSUD, USDG, etc are issuing their own stablecoins.

Your mission, should you choose to accept it, is to write a comprehensive deep dive about the state of stablecoins on Solana. The ideal submission will:

Present an overview of key network level metrics and comment on trends

Highlight, and explain past the headline, all key product developements, integrations and features related to stablecoins

Draw out an ecosystem map highlighting distinct sectors within the stabelcoin domain and the key players in it

Compare and contrast regulatory approaches across the world and draw common trends and predictions for the future

Suggest & develop interesting opportunities or product ideas for the application of stablecoins.

Sound opinioniated and interesting vs just being an information dump

Other Evaluation Criteria
In addition to the criteria shared above, our judges will use the following criteria will judging your submissions

Did you write a compelling introduction and a satisfying conclusion?

Is your writing easy and fun to read?

Did you avoid overly complex jargon?

Did you explain concepts in a way a person new to crypto could understand?

`;

  const currentBountyDescription = bountyDescription || defaultBountyDescription;

  const prompt = `
You are an EXTREMELY strict and elite judge for a bounty competition evaluating deep-dive essays on: **${topic}**.

${currentBountyDescription}

🔥 CRITICAL: You are looking for the TOP 1% of submissions that meet these specific bounty criteria. Most will disappoint you.

VISUAL ANALYSIS: This text was extracted from a PDF. Look for evidence of:
- References to charts, graphs, or visual elements
- Table-like data or structured formatting  
- Mentions of "see chart above" or "as shown in figure"
- Lists or data suggesting visual presentation
- Formatting clues indicating sophisticated visual organization

⚡ WEIGHTED SCORING RUBRIC (0-18 points):

**BOUNTY DELIVERABLES COVERAGE (8 points) - MOST IMPORTANT**
- 0-2: Missing most required deliverables, superficial treatment
- 3-4: Covers some deliverables but lacks depth or misses key elements
- 5-6: Good coverage of most deliverables with adequate depth
- 7-8: Comprehensive coverage of ALL deliverables with exceptional depth and insight

**ORIGINAL INSIGHT & ANALYSIS (4 points)**
- 0-1: Rehashes obvious points, no unique perspective
- 2-3: Some original thoughts but not groundbreaking
- 4: Genuinely surprising observations, predictions, or frameworks

**WRITING QUALITY & ACCESSIBILITY (3 points)**
- 0-1: Poor structure, unclear for newcomers, boring
- 2: Decent structure but lacks engagement or clarity
- 3: Compelling, accessible, well-structured with engaging voice

**ECOSYSTEM DEPTH & ACCURACY (2 points)**
- 0-1: Shallow or inaccurate ecosystem coverage
- 2: Deep, accurate coverage of key players and relationships

**VISUAL PRESENTATION (1 point)**
- 0: No visual elements or data presentation
- 1: Clear evidence of charts, graphs, or structured data presentation

🚨 BRUTAL SCORING STANDARDS:

**0-6 points: FAILS BOUNTY REQUIREMENTS**
- Missing core deliverables from bounty description
- Generic content that could apply to any blockchain
- Poor writing quality, inaccessible to newcomers

**7-10 points: PARTIALLY MEETS REQUIREMENTS** 
- Covers some deliverables but misses key elements
- Basic treatment without depth or originality
- Adequate writing but not engaging

**11-13 points: MEETS MOST REQUIREMENTS**
- Covers most deliverables with good depth
- Shows understanding and some unique angles
- Well-written and accessible

**14-16 points: EXCEEDS REQUIREMENTS**
- Comprehensive coverage of ALL deliverables
- Deep insights with original frameworks
- Exceptional writing quality and presentation

**17-18 points: LEGENDARY BOUNTY SUBMISSION**
- Paradigm-shifting insights that redefine the space
- Perfect execution of all deliverables
- Writing quality that sets new standards

⚠️ MANDATORY PENALTIES:
- Missing network-level metrics: -3 points
- No ecosystem map or shallow ecosystem coverage: -4 points
- Missing regulatory analysis: -2 points
- Poor accessibility for newcomers: -2 points
- No visual elements when discussing data: -2 points
- Factual errors: -2 points

🎯 JUDGE MINDSET:
- You are evaluating against SPECIFIC bounty requirements
- Most submissions will fail to meet the comprehensive deliverables
- High scores (14+) require meeting ALL bounty criteria exceptionally well
- When in doubt about deliverable coverage, score LOWER

Your reputation depends on identifying submissions that truly fulfill the bounty requirements.

Return ONLY valid JSON in this exact format (no markdown, no explanations, no extra text):
{
  "score": total_score,
  "reasoning": [
    "critical feedback or praise about conceptual coverage",
    "judgment on ecosystem/product depth (what was covered well or missing)",
    "comment on structure, clarity, writing style, and any evidence of visual presentation",
    "description of any original idea or framing — quote or explain it clearly",
    "note a specific strength or flaw that sets the submission apart, including presentation quality"
  ]
}

Here is the article text:
"""${text.length > 12000 ? text.slice(0, 6000) + "\n...\n" + text.slice(-3000) : text}"""
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 1000
  });

  if (!response || !response.choices || !response.choices.length) {
    throw new Error("Invalid or empty response from OpenAI");
  }

  return response.choices[0].message.content;
}

async function runComparativeJudgment(results) {
  const top10 = results.sort((a, b) => b.Score - a.Score).slice(0, 10);

  const formatted = top10.map((entry, i) => `## Entry ${i + 1}: ${entry.Name}\nScore: ${entry.Score}/18\n---\n${entry.Reasoning.map(r => `- ${r}`).join('\n')}`).join('\n\n');

  const comparisonPrompt = `
You're now the final judge for a bounty contest. You have been given the top 10 submissions, each with a prior score and reasoning.

Your task: Choose the 3 **best submissions** in strict order based on:
- Depth of ecosystem coverage
- Original insight
- Clarity & writing quality

Give decisive rankings. Don't favor generalists or safe entries — reward bold, insightful, and ecosystem-aware work.

Here are the submissions:

${formatted}

Return ONLY this JSON:
{
  "rankings": [
    {"name": "Name 1"},
    {"name": "Name 2"},
    {"name": "Name 3"}
  ],
  "justification": [
    "Why #1 was chosen",
    "Why #2 was next best",
    "Why #3 made the cut"
  ]
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: comparisonPrompt }],
    temperature: 0.2
  });

  const output = JSON.parse(response.choices[0].message.content);
  generateFinalReadme(output, results);
}

function generateFinalReadme(finalResult, allResults) {
  const medals = ['🥇', '🥈', '🥉'];
  const ranked = finalResult.rankings.map(r => allResults.find(x => x.Name === r.name));

  const content = ranked.map((entry, i) => `### ${medals[i]} Rank ${i + 1}: ${entry.Name}

**Link:** ${entry.Link}  
**Word Count:** ${entry.WordCount}  
**Score:** ${entry.Score}/18  
**Reasoning:**\n${entry.Reasoning.map(r => `- ${r}`).join('\n')}

**Judge’s Verdict:** ${finalResult.justification[i]}

---`).join('\n\n');

  fs.writeFileSync('RESULTS.md', content);
  console.log('📝 README.md created from comparative judgment.');
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}
