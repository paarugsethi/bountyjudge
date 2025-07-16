### This repo has scripts to complete two tasks:
- wordcounter.js takes submissions.csv as input and outputs submissions_with_count.csv containing only the submissions that have 2000+ words
- once submissions_with_count.csv is created, judge-ai.js ranks and outputs RESULTS.md with the top-3 submissions

**NOTE:** submissions.csv should only have Name,Submission Link,Email ID

Final steps to judge bounties from Earn:
1. Export submissions as CSV from Earn
2. Import the CSV in Sheets and delete all columns except Name, Submission Link and Email ID
3. Export this Sheet as CSV (as submissions.csv) and add it to the project directory
4. Run ```node wordcounter.js```
5. Once submissions_with_count.csv is created, run ```node judge-ai.js```