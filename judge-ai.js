const fs = require('fs');
const csv = require('csv-parser');
require('dotenv').config();
const OpenAI = require('openai');

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

  for (const row of rows) {
    try {
      const text = fs.readFileSync(`texts/${sanitizeFilename(row.Name)}.txt`, 'utf-8');
      const aiResponse = await evaluateSubmission(text);
      const { score, reasoning } = JSON.parse(aiResponse);

      results.push({
        Name: row.Name,
        Link: row['Submission Link'],
        WordCount: row['Word Count'],
        Score: score,
        Reasoning: reasoning
      });

      console.log(`✅ Scored ${row.Name}: ${score}/18`);
    } catch (err) {
      console.error(`❌ ${row.Name}: ${err.message}`);
    }
  }

  fs.writeFileSync(allResultsPath, JSON.stringify(results, null, 2));
  runComparativeJudgment(results);
}

async function evaluateSubmission(text) {
  const topic = "the State of RWAs on Solana";

  const prompt = `
You are a very strict and thoughtful judge for a bounty competition evaluating deep-dive essays on the topic of: **${topic}**.

You must give each submission a score from 0 to 18. Use this weighted rubric:

1. Core Concepts — Are key concepts explained clearly and correctly?
2. Ecosystem Coverage (most important) — Are major tools, products, or participants discussed with depth and insight?
3. Landscape Mapping — Does the submission organize the space meaningfully (e.g. segments, roles, verticals)?
4. External Context — Are regulatory, economic, or technological forces covered?
5. Original Insight (most important) — Does the piece offer surprising observations, predictions, frameworks, or critiques?
6. Opinionated Voice — Does the author have a confident, distinct point of view?
7. Clarity & Readability — Is it accessible, well-structured, and engaging?

Submissions must **stand out**. 
- Penalize articles that summarize obvious ideas, list features without depth, or offer no fresh framing.
- A well-written but generic article should **not** score above 10/18.

⚠️ Scoring Instructions:

Scoring bands:
- 5–8: Generic, safe, lacks depth or insight
- 9–12: Good, covers basics, some perspective
- 13–15: Strong framing or insight, but not groundbreaking
- 16–18: Exceptional — rare originality, insight, or synthesis
- If unsure between two scores, choose the lower.

Be strict and discriminative.
You are judging 40+ entries. Your job is to **rank** the best — not to praise everyone.
Avoid giving high scores to submissions that are long but repetitive or verbose. Quality > length.
Do not reward good writing alone. Reward depth, framing, and unique value.

Return ONLY this JSON format:
{
  "score": total_score,
  "reasoning": [
    "critical feedback or praise about conceptual coverage",
    "judgment on ecosystem/product depth (what was covered well or missing)",
    "comment on structure, clarity, or writing style",
    "description of any original idea or framing — quote or explain it clearly",
    "note a specific strength or flaw that sets the submission apart"
  ]
}

Here is the article:
"""${text.length > 10000 ? text.slice(0, 5000) + "\n...\n" + text.slice(-2000) : text}"""
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2
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
