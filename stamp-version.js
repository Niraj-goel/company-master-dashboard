// Writes version.json (Company Master) and Checklist/version.json (Job Checklist): the recent changes from git, so the
// dashboards can show "Last updated … – what changed" even where the host runs them without the .git folder.
// Run it just before committing, with the summary of the commit about to be made, and commit the json files with it:
//   node stamp-version.js "Compliance: due dates and registrations"            (Company Master change)
//   node stamp-version.js --checklist "Job Checklist: ..."                     (Job Checklist change)
const fs = require("fs");
const path = require("path");
const {execFileSync} = require("child_process");

const args = process.argv.slice(2), checklist = args.includes("--checklist");
const summary = args.filter(a => a !== "--checklist").join(" ").trim();

const log = pathspec => execFileSync("git", ["log", "-14", "--format=%cI%x09%s", "--", ...pathspec], {cwd: __dirname})
  .toString().trim().split("\n").filter(Boolean).map(l => { const [at, ...s] = l.split("\t"); return {at, summary: s.join("\t")}; });

const write = (file, pathspec, upcoming) => {
  const changes = (upcoming ? [{at: new Date().toISOString(), summary: upcoming}] : []).concat(log(pathspec)).slice(0, 15);
  fs.writeFileSync(path.join(__dirname, file), JSON.stringify({changes}, null, 1) + "\n");
};
if (!checklist) write("version.json", [".", ":(exclude)Checklist", ":(exclude)version.json"], summary);
if (checklist || !summary) write("Checklist/version.json", ["Checklist", ":(exclude)Checklist/version.json"], checklist ? summary : "");
console.log("Stamped", checklist ? "Checklist/version.json" : summary ? "version.json" : "both");
