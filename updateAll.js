// updateAll.js - pull from Render → update prices → commit & push

const { execSync } = require("child_process");

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function main() {
  try {
    // 1) Pull latest inventory from Render
    run("node pullInventory.js");

    // 2) Update prices locally (respects 24h cooldown)
    run("node updatePrices.js");

    // 3) Commit changes (if any)
    try {
      run('git add inventory.json');
      run('git commit -m "chore: update inventory prices"');
    } catch (err) {
      console.warn(
        "⚠ git commit failed (probably no changes to commit):",
        err.message || err
      );
    }

    // 4) Push to remote
    try {
      run("git push");
    } catch (err) {
      console.error(
        "❌ git push failed. Check your remote, auth (GitHub token/SSH), or network."
      );
      process.exit(1);
    }

    console.log("\n✅ All done: pulled, updated, committed, and pushed.");
  } catch (err) {
    console.error("\n❌ updateAll failed:", err.message || err);
    process.exit(1);
  }
}

main();
