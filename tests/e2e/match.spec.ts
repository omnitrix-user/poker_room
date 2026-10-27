import { expect, test, type Page } from "@playwright/test";

async function chooseName(page: Page, name: string, button: string) {
  await page.getByLabel("Your name at the table").fill(name);
  await page.getByRole("button", { name: button }).click();
}

test.setTimeout(240_000);

test("a 10-round match: extension vote refused, leaderboard ordered by profit", async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  await host.goto("/");
  await chooseName(host, "Meera", "Continue");
  await host.getByLabel("Turn clock").selectOption("0");
  await host.getByLabel("Rounds").selectOption("10");
  await host.getByRole("button", { name: "Open table" }).click();
  await host.waitForURL(/\/r\/[A-Z0-9]{8}$/);
  const code = host.url().split("/").pop()!;

  await guest.goto(`/r/${code}`);
  await chooseName(guest, "Kabir", "Join table");
  await guest.getByRole("button", { name: "I'm ready" }).click();
  await host.getByRole("button", { name: "Start game" }).click();

  await expect(host.locator(".round-counter")).toContainText("Round 1");
  await expect(host.locator(".round-counter")).toContainText("/ 10");
  // Amounts are shown in rupees.
  await expect(host.locator(".pot-amount")).toContainText("₹");

  // Play all ten rounds passively (the host folds when facing a bet; otherwise both check or
  // call). Then the final-round window appears.
  const finalWindow = host.getByRole("dialog", { name: "That was the final round" });
  // Time-based so it also works against a deployment with production pacing between hands.
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && !(await finalWindow.isVisible())) {
    for (const p of [host, guest]) {
      if (!(await p.locator(".actionbar.live").isVisible())) continue;
      const fold = p.getByRole("button", { name: /^Fold$/ });
      const check = p.getByRole("button", { name: /^Check$/ });
      if (p === host && (await fold.isVisible())) await fold.click();
      else if (await check.isVisible()) await check.click();
      else await p.getByRole("button", { name: /^Call/ }).click();
    }
    await host.waitForTimeout(100);
  }
  await expect(finalWindow).toBeVisible();
  await expect(host.locator(".round-counter")).toContainText("10");

  // The host proposes more rounds; the guest says no, so the match ends as planned.
  await finalWindow.getByRole("button", { name: "+5 rounds" }).click();
  const vote = guest.getByRole("dialog", { name: /wants 5 more rounds/ });
  await expect(vote).toBeVisible();
  await expect(vote).toContainText("Playing to 15 instead of 10");
  await vote.getByRole("button", { name: "No, finish on time" }).click();

  // Both see the final leaderboard, biggest profit first.
  for (const p of [host, guest]) {
    const board = p.getByRole("dialog", { name: "Leaderboard" });
    await expect(board).toBeVisible({ timeout: 10_000 });
    await expect(board).toContainText("10 of 10 rounds");
    const pl = await board.locator("td.pl").allTextContents();
    const values = pl.map((t) => {
      const n = Number(t.replace(/[^\d]/g, ""));
      return t.trim().startsWith("−") ? -n : n;
    });
    expect(values).toHaveLength(2);
    expect(values[0]!).toBeGreaterThanOrEqual(values[1]!);
    expect(values[0]! + values[1]!).toBe(0);
  }

  await hostCtx.close();
  await guestCtx.close();
});
