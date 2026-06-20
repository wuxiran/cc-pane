import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGit(cwd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`git ${args.join(" ")} failed in ${cwd}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function initRepo(repoDir) {
  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ["init"]);
  await runGit(repoDir, ["config", "user.email", "smoke@example.com"]);
  await runGit(repoDir, ["config", "user.name", "Smoke User"]);
  await writeFile(path.join(repoDir, "README.md"), "initial\n");
  await runGit(repoDir, ["add", "README.md"]);
  await runGit(repoDir, ["commit", "-m", "initial"]);
}

async function startStaticServer(rootDir) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const filePath = path.join(rootDir, decodeURIComponent(url.pathname));
      const body = await readFile(filePath);
      res.writeHead(200, { "content-length": body.length });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start static HTTP server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function verifyWebGitApis({
  webBaseUrl,
  rootDir,
  requestJson,
  requestNoContent,
  assertEquals,
  fail,
  log,
}) {
  log("verifying web git and worktree APIs");
  const cleanupDirs = [];
  const servers = [];
  try {
    const remote = path.join(rootDir, "git-remote.git");
    await runGit(rootDir, ["init", "--bare", remote]);

    const repo = path.join(rootDir, "git-project");
    await initRepo(repo);
    await runGit(repo, ["remote", "add", "origin", remote]);
    await runGit(repo, ["push", "-u", "origin", "HEAD"]);

    const branch = await requestJson(
      webBaseUrl,
      `/api/git/branch?path=${encodeURIComponent(repo)}`,
    );
    if (branch !== "main" && branch !== "master") {
      fail(`git branch returned invalid payload: ${JSON.stringify(branch)}`);
    }

    await writeFile(path.join(repo, "README.md"), "modified\n");
    await writeFile(path.join(repo, "untracked.txt"), "untracked\n");
    const dirty = await requestJson(
      webBaseUrl,
      `/api/git/status?path=${encodeURIComponent(repo)}`,
    );
    assertEquals(dirty, true, "git dirty status");

    const statuses = await requestJson(
      webBaseUrl,
      `/api/git/file-statuses?path=${encodeURIComponent(repo)}`,
    );
    assertEquals(statuses[path.join(repo, "README.md")], "modified", "git modified status");
    assertEquals(statuses[path.join(repo, "untracked.txt")], "untracked", "git untracked status");

    await requestJson(webBaseUrl, "/api/git/stash", {
      method: "POST",
      body: JSON.stringify({ path: repo }),
    });
    await requestJson(webBaseUrl, "/api/git/stash-pop", {
      method: "POST",
      body: JSON.stringify({ path: repo }),
    });
    const readmeAfterPop = await readFile(path.join(repo, "README.md"), "utf8");
    assertEquals(readmeAfterPop, "modified\n", "git stash pop content");
    await runGit(repo, ["checkout", "--", "README.md"]);
    await rm(path.join(repo, "untracked.txt"), { force: true });

    await writeFile(path.join(repo, "local.txt"), "local\n");
    await runGit(repo, ["add", "local.txt"]);
    await runGit(repo, ["commit", "-m", "local update"]);
    await requestJson(webBaseUrl, "/api/git/push", {
      method: "POST",
      body: JSON.stringify({ path: repo }),
    });
    await requestJson(webBaseUrl, "/api/git/fetch", {
      method: "POST",
      body: JSON.stringify({ path: repo }),
    });

    const clone = path.join(rootDir, "git-clone");
    await runGit(rootDir, ["clone", remote, clone]);
    await runGit(clone, ["config", "user.email", "smoke@example.com"]);
    await runGit(clone, ["config", "user.name", "Smoke User"]);
    await writeFile(path.join(clone, "remote.txt"), "remote\n");
    await runGit(clone, ["add", "remote.txt"]);
    await runGit(clone, ["commit", "-m", "remote update"]);
    await runGit(clone, ["push", "origin", "HEAD"]);
    await requestJson(webBaseUrl, "/api/git/pull", {
      method: "POST",
      body: JSON.stringify({ path: repo }),
    });
    const pulled = await readFile(path.join(repo, "remote.txt"), "utf8");
    assertEquals(pulled, "remote\n", "git pull content");

    const dumbRemote = await mkdtemp(path.join(tmpdir(), "cc-panes-web-git-http-"));
    cleanupDirs.push(dumbRemote);
    await runGit(rootDir, ["clone", "--bare", repo, path.join(dumbRemote, "project.git")]);
    await runGit(path.join(dumbRemote, "project.git"), ["update-server-info"]);
    const staticServer = await startStaticServer(dumbRemote);
    servers.push(staticServer);
    const httpClonePath = await requestJson(webBaseUrl, "/api/git/clone", {
      method: "POST",
      body: JSON.stringify({
        url: `${staticServer.baseUrl}/project.git`,
        targetDir: rootDir,
        folderName: "git-http-clone",
        shallow: false,
      }),
    });
    assertEquals(httpClonePath, path.join(rootDir, "git-http-clone"), "git clone path");

    const isRepo = await requestJson(
      webBaseUrl,
      `/api/worktrees/is-git-repo?projectPath=${encodeURIComponent(repo)}`,
    );
    assertEquals(isRepo, true, "worktree is git repo");
    const beforeWorktrees = await requestJson(
      webBaseUrl,
      `/api/worktrees?projectPath=${encodeURIComponent(repo)}`,
    );
    assertEquals(beforeWorktrees.length, 1, "initial worktree count");
    const worktreePath = await requestJson(webBaseUrl, "/api/worktrees", {
      method: "POST",
      body: JSON.stringify({
        projectPath: repo,
        name: "smoke-feature",
        branch: "smoke-feature",
      }),
    });
    const afterWorktrees = await requestJson(
      webBaseUrl,
      `/api/worktrees?projectPath=${encodeURIComponent(repo)}`,
    );
    if (!afterWorktrees.some((worktree) => worktree.path === worktreePath)) {
      fail(`worktree list did not contain created worktree: ${JSON.stringify(afterWorktrees)}`);
    }
    await requestNoContent(webBaseUrl, "/api/worktrees", {
      method: "DELETE",
      body: JSON.stringify({ projectPath: repo, worktreePath }),
    });
  } finally {
    await Promise.allSettled(servers.map((server) => server.close()));
    await Promise.allSettled(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await sleep(10);
  }
}
