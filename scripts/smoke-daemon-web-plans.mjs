import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function verifyWebPlanApis({
  webBaseUrl,
  rootDir,
  requestJson,
  requestNoContent,
  assertEquals,
  fail,
  log,
}) {
  log("verifying web archived plan APIs");

  const projectDir = path.join(rootDir, "plans-project");
  const plansDir = path.join(projectDir, ".ccpanes", "plans");
  const fileName = "abcd1234_20260620_101112_web-smoke-plan.md";
  await mkdir(plansDir, { recursive: true });
  await writeFile(path.join(plansDir, fileName), "# Web Smoke Plan\n\nPlan body");

  const encodedProject = encodeURIComponent(projectDir);
  const listed = await requestJson(webBaseUrl, `/api/plans?projectPath=${encodedProject}`);
  if (!Array.isArray(listed) || listed.length !== 1) {
    fail(`plans list returned invalid payload: ${JSON.stringify(listed)}`);
  }
  assertEquals(listed[0].fileName, fileName, "plan list file name");
  assertEquals(listed[0].sessionId, "abcd1234", "plan list session id");
  assertEquals(listed[0].archivedAt, "2026-06-20T10:11:12", "plan list archived at");

  const content = await requestJson(
    webBaseUrl,
    `/api/plans/${encodeURIComponent(fileName)}?projectPath=${encodedProject}`,
  );
  if (!content.includes("Web Smoke Plan")) {
    fail(`plan content missing title: ${JSON.stringify(content)}`);
  }

  await requestNoContent(
    webBaseUrl,
    `/api/plans/${encodeURIComponent(fileName)}?projectPath=${encodedProject}`,
    { method: "DELETE" },
  );

  const afterDelete = await requestJson(webBaseUrl, `/api/plans?projectPath=${encodedProject}`);
  assertEquals(afterDelete.length, 0, "plans list after delete");
}
