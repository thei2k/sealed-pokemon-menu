// updateAll.js
const { execSync } = require("child_process");

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function main() {
  try {
    // 1) Pull latest inventory from Render
    run("node pullInventory.js");

    // 2) Update prices locally
    run("node updateprices.js");

    // 3) Stage changes (inventory.json at minimum)
    run("git add inventory.json");

    // 4) Commit changes if there are any
    try {
      run('git commit -m "Update inventory prices"');
    } catch (err) {
      // Most common reason: "nothing to commit, working tree clean"
      console.log("ℹ No changes to commit (inventory.json already up to date).");
    }

    // 5) Push to remote
    try {
      run("git push");
    } catch (err) {
      console.error(
        "❌ git push failed. Check your remote, auth (GitHub login/SSH), or network."
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
