#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const ROOT = '/app/fto/frontend';
const WATCH_DIRS = ['app'];
const WATCH_FILES = ['package.json', 'package-lock.json', 'next.config.js'];
const SCAN_INTERVAL_MS = 2000;
const DEBOUNCE_MS = 1500;

let lastSignature = '';
let buildRunning = false;
let pendingBuild = false;
let debounceTimer = null;

function shouldWatchFile(filePath) {
  const ext = path.extname(filePath);
  return ['.js', '.jsx', '.ts', '.tsx', '.css', '.json'].includes(ext);
}

function collectFiles(dirPath, files) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.next' || entry.name === 'node_modules') {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, files);
      continue;
    }
    if (shouldWatchFile(fullPath)) {
      files.push(fullPath);
    }
  }
}

function snapshotSignature() {
  const files = [];
  for (const dir of WATCH_DIRS) {
    const fullDir = path.join(ROOT, dir);
    if (fs.existsSync(fullDir)) {
      collectFiles(fullDir, files);
    }
  }
  for (const file of WATCH_FILES) {
    const fullPath = path.join(ROOT, file);
    if (fs.existsSync(fullPath)) {
      files.push(fullPath);
    }
  }

  files.sort();
  return files
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      return `${filePath}:${stat.mtimeMs}:${stat.size}`;
    })
    .join('|');
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function rebuildFrontend() {
  if (buildRunning) {
    pendingBuild = true;
    return;
  }

  buildRunning = true;
  pendingBuild = false;
  console.log(`[watch] change detected at ${new Date().toISOString()}`);

  try {
    await runCommand('npm', ['run', 'build'], ROOT);
    await runCommand('systemctl', ['restart', 'fto-frontend'], '/app/fto');
    console.log(`[watch] rebuild and restart succeeded at ${new Date().toISOString()}`);
  } catch (error) {
    console.error(`[watch] rebuild failed: ${error.message}`);
  } finally {
    buildRunning = false;
    if (pendingBuild) {
      pendingBuild = false;
      void rebuildFrontend();
    }
  }
}

function scheduleBuild() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void rebuildFrontend();
  }, DEBOUNCE_MS);
}

function tick() {
  try {
    const nextSignature = snapshotSignature();
    if (!lastSignature) {
      lastSignature = nextSignature;
      console.log(`[watch] baseline captured at ${new Date().toISOString()}`);
      return;
    }
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature;
      scheduleBuild();
    }
  } catch (error) {
    console.error(`[watch] scan failed: ${error.message}`);
  }
}

console.log('[watch] fto frontend production watcher started');
tick();
setInterval(tick, SCAN_INTERVAL_MS);