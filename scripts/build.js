const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const javascriptFiles = [];

function collectJavaScriptFiles(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });

    entries.forEach((entry) => {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
            return;
        }

        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collectJavaScriptFiles(entryPath);
        } else if (
            entry.isFile() &&
            (/\.[cm]?js$/.test(entry.name) || entryPath === path.join(projectRoot, 'bin', 'www'))
        ) {
            javascriptFiles.push(entryPath);
        }
    });
}

collectJavaScriptFiles(projectRoot);

let failed = false;
javascriptFiles.forEach((filePath) => {
    const result = spawnSync(process.execPath, ['--check', filePath], { stdio: 'inherit' });
    if (result.error) {
        console.error(`Could not check ${path.relative(projectRoot, filePath)}: ${result.error.message}`);
        failed = true;
    } else if (result.status !== 0) {
        failed = true;
    }
});

if (failed) {
    process.exitCode = 1;
} else {
    console.log(`Syntax check passed for ${javascriptFiles.length} JavaScript files.`);
}
