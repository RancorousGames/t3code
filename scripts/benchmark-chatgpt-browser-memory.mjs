// T3-0226 isolated comparison. Never imports any T3/ChatGPT credentials or touches existing guests.
import { createRequire } from "node:module";
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const requireDesktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { chromium } = requireDesktop("playwright-core");
const appRoot = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = Path.join(appRoot, ".t3", "worker-reports");
const browserKind = process.env.T3_BENCHMARK_BROWSER === "chrome" ? "Chrome" : "Chromium";
const profilePath = Path.join(Os.tmpdir(), "t3-0226-isolated-" + browserKind.toLowerCase() + "-" + Crypto.randomUUID());
const headless = process.env.T3_BENCHMARK_HEADLESS !== "0";
const chromiumBinary = browserKind === "Chrome"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : Path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1248", "chrome-win64", "chrome.exe");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n) => Math.round(n * 10) / 10;
const measureProcessTree = (userDataDir) => {
  const command = String.raw`$all=@(Get-CimInstance Win32_Process);
$expected=$env:T3_BENCHMARK_PROFILE;
$roots=@($all | Where-Object {
  $_.Name -ieq 'chrome.exe' -and $_.CommandLine -like ('*'+$expected+'*') -and $_.CommandLine -notmatch '--type='
});
$related=@($roots);
for($step=0; $step -lt 8; $step++) {
  $more=@($all | Where-Object {
    $related.ProcessId -contains $_.ParentProcessId -and $related.ProcessId -notcontains $_.ProcessId
  });
  if($more.Count -eq 0){break}
  $related += $more
};
$rows=@(foreach($entry in $related) {
  try {
    $p=Get-Process -Id $entry.ProcessId -ErrorAction Stop;
    [pscustomobject]@{
      pid=$entry.ProcessId;
      type=$(if($entry.CommandLine -match '--type=([^ ]+)'){$Matches[1]}else{'browser'});
      workingMB=[math]::Round($p.WorkingSet64/1MB,2);
      privateMB=[math]::Round($p.PrivateMemorySize64/1MB,2)
    }
  } catch {}
});
[pscustomobject]@{
  rootCount=$roots.Count;
  count=$rows.Count;
  workingMB=[math]::Round((($rows|Measure-Object workingMB -Sum).Sum),2);
  privateMB=[math]::Round((($rows|Measure-Object privateMB -Sum).Sum),2);
  rendererCount=@($rows|Where-Object {$_.type -eq 'renderer'}).Count;
  rendererWorkingMB=[math]::Round((($rows|Where-Object {$_.type -eq 'renderer'}|Measure-Object workingMB -Sum).Sum),2);
  processes=$rows
} | ConvertTo-Json -Depth 5 -Compress`;
  const response = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    timeout: 16000,
    env: { ...process.env, T3_BENCHMARK_PROFILE: userDataDir },
    windowsHide: true,
  });
  return JSON.parse(response);
};
const pageStats = async (page) => {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Performance.enable");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const map = new Map(metrics.map((p) => [p.name, p.value]));
    return { v8UsedMB: round((map.get("JSHeapUsedSize") ?? 0) / 1024 / 1024),
      v8TotalMB: round((map.get("JSHeapTotalSize") ?? 0) / 1024 / 1024) };
  } finally { await cdp.detach(); }
};
const sample = async (label, page) => {
  const snapshots = [];
  for (let i = 0; i < 3; i++) {
    await sleep(1200);
    snapshots.push({ ...measureProcessTree(profilePath), ...(await pageStats(page)) });
  }
  const median = (name) => [...snapshots].map((r) => r[name]).sort((a, b) => a - b)[1];
  return { label, count: median("count"), rendererCount: median("rendererCount"),
    workingMB: median("workingMB"), privateMB: median("privateMB"), rendererWorkingMB: median("rendererWorkingMB"),
    v8UsedMB: median("v8UsedMB"), v8TotalMB: median("v8TotalMB"), snapshots };
};

await Fs.mkdir(reportDir, { recursive: true });
const report = { measuredAt: new Date().toISOString(), browserKind, chromiumBinary,
  browserMode: headless ? "headless" : "headed", sessionMode: "isolated unauthenticated no cookies",
  comparisonCaveat: "An isolated ChatGPT home/login page may be lighter than a real authenticated conversation; T3 session metrics come from Electron renderer-only historical telemetry. Windows process working-set sums can double-count shared memory.",
  stages: [], page: {} };
let context;
try {
  context = await chromium.launchPersistentContext(profilePath, {
    executablePath: chromiumBinary,
    headless,
    viewport: { width: 1280, height: 800 },
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("about:blank");
  await sleep(1000);
  report.stages.push(await sample(browserKind + ": blank tab", page));
  try {
    const response = await page.goto("https://chatgpt.com", {
      waitUntil: "domcontentloaded", timeout: 30000,
    });
    report.page.httpStatus = response?.status() ?? null;
    await sleep(7000);
    report.page.url = page.url();
    report.page.title = await page.title().catch(() => null);
    report.page.observed = await page.evaluate(() => ({
      hasLogin: Boolean(document.querySelector('[data-testid="login-button"], a[href*="login"], input[type="password"]')),
      hasComposer: Boolean(document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]')),
      hasConversationMessages: document.querySelectorAll('[data-message-author-role]').length,
    })).catch((err) => ({ probeError: String(err) }));
  } catch (error) {
    report.page.loadError = error instanceof Error ? error.message : String(error);
  }
  report.stages.push(await sample(browserKind + ": ChatGPT home", page));
  report.delta = { workingMB: round(report.stages[1].workingMB - report.stages[0].workingMB),
    privateMB: round(report.stages[1].privateMB - report.stages[0].privateMB),
    rendererWorkingMB: round(report.stages[1].rendererWorkingMB - report.stages[0].rendererWorkingMB) };
} finally {
  await context?.close().catch(() => {});
  await Fs.rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = Path.join(reportDir, "T3-0226-" + browserKind.toLowerCase() + "-benchmark-" + stamp + ".json");
await Fs.writeFile(output, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ output, stages: report.stages.map(({ label, count, rendererCount, workingMB, privateMB, rendererWorkingMB, v8UsedMB }) =>
  ({ label, count, rendererCount, workingMB, privateMB, rendererWorkingMB, v8UsedMB })), page: report.page, delta: report.delta }, null, 2));
