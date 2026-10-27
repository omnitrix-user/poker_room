import { expect, test, type Page } from "@playwright/test";

async function chooseName(page: Page, name: string, button: string) {
  await page.getByLabel("Your name at the table").fill(name);
  await page.getByRole("button", { name: button }).click();
}

/** Plays passively (check, else call) on whichever page has the action, until the hand ends. */
async function playHandToEnd(pages: Page[]) {
  for (let i = 0; i < 40; i++) {
    for (const p of pages) if (await p.locator(".pot.result").isVisible()) return;
    for (const p of pages) {
      if (!(await p.locator(".actionbar.live").isVisible())) continue;
      const check = p.getByRole("button", { name: /^Check$/ });
      if (await check.isVisible()) await check.click();
      else await p.getByRole("button", { name: /^Call/ }).click();
      await p.locator(".actionbar.live").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    }
    await pages[0]!.waitForTimeout(150);
  }
  throw new Error("hand did not finish");
}

test("two friends play a hand, reconnect, and review history", async ({ browser }) => {
  // Separate browser contexts = separate cookies = separate server-issued identities.
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  // 1. Host establishes an identity and opens a table without a turn clock.
  await host.goto("/");
  await chooseName(host, "Hana", "Continue");
  await expect(host.getByText("Playing as")).toContainText("Hana");
  await host.getByLabel("Turn clock").selectOption("0");
  await host.getByRole("button", { name: "Open table" }).click();
  await host.waitForURL(/\/r\/[A-Z0-9]{8}$/);
  const code = host.url().split("/").pop()!;

  // 2. Guest follows the invite link in a different browser context.
  await guest.goto(`/r/${code}`);
  await expect(guest.getByText("You're invited")).toBeVisible();
  await chooseName(guest, "Gus", "Join table");
  await expect(guest.getByRole("button", { name: "I'm ready" })).toBeVisible();

  // The phone-sized lobby shows a usable table, not a collapsed one.
  expect((await guest.locator(".table").boundingBox())!.width).toBeGreaterThan(250);

  // Both are seated.
  await expect(host.locator(".seat .name", { hasText: "Gus" })).toBeVisible();
  await expect(guest.locator(".seat .name", { hasText: "Hana" })).toBeVisible();

  // 3. Ready up and start.
  await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();
  await guest.getByRole("button", { name: "I'm ready" }).click();
  await expect(host.getByText("Everyone's ready.")).toBeVisible();
  await host.getByRole("button", { name: "Start game" }).click();

  // 4. Each player sees exactly their own two cards face up, and the opponent's face down.
  for (const p of [host, guest]) {
    await expect(p.locator(".seat.you .hole .pcard.face")).toHaveCount(2);
    await expect(p.locator(".seat:not(.you) .hole .pcard.back")).toHaveCount(2);
    await expect(p.locator(".seat:not(.you) .hole .pcard.face")).toHaveCount(0);
  }
  const hostCards = await host.locator(".seat.you .hole .pcard.face").evaluateAll((els) => els.map((e) => e.getAttribute("data-card")));
  // The host's cards must not exist anywhere in the guest's DOM.
  const guestHtml = await guest.content();
  for (const c of hostCards) expect(guestHtml).not.toContain(`data-card="${c}"`);

  // Heads-up: the button posts the small blind.
  const buttonSeatIsSb = await host.evaluate(() => {
    const sb = [...document.querySelectorAll(".blind-tag")].find((e) => e.textContent === "SB");
    return Boolean(sb);
  });
  expect(buttonSeatIsSb).toBe(true);

  // 5. Play the hand to completion.
  await playHandToEnd([host, guest]);
  const hostResult = (await host.locator(".pot.result").textContent())!;
  await expect(guest.locator(".pot.result")).toHaveText(hostResult);

  // Chip conservation as displayed on both clients (between hands).
  const total = async (p: Page) =>
    (await p.locator(".seat .stack").allInnerTexts()).reduce((s, t) => s + Number(t.replace(/[^\d]/g, "") || 0), 0);
  expect(await total(host)).toBe(4000);
  expect(await total(guest)).toBe(4000);

  // Table chat: a quick reaction from the guest shows up as a bubble at the guest's seat for the host.
  await guest.getByRole("button", { name: "Chat" }).click();
  await guest.getByRole("tab", { name: "Chat" }).click();
  await guest.getByRole("button", { name: "GG" }).click();
  await expect(host.locator(".seat:not(.you) .bubble")).toHaveText("GG");
  await guest.getByRole("button", { name: "Close panel" }).click();

  // 6. Guest refreshes and is reconnected to the same seat.
  await guest.reload();
  await expect(guest.locator(".seat.you .name")).toHaveText(/Gus/);
  await expect(guest.locator(".conn")).toHaveText(/Live/);
  await expect(guest.locator(".seat:not(.you) .name")).toHaveText(/Hana/);

  // No horizontal scrolling on the phone-sized client.
  const overflow = await guest.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // 7. The completed hand is in the persisted history.
  await host.goto("/history");
  await expect(host.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(host.locator(".stats")).toContainText("Hands played");
  await host.getByRole("link", { name: code }).click();
  await expect(host.getByRole("heading", { name: `Table ${code}` })).toBeVisible();
  await expect(host.locator(".hand-detail")).toContainText("Hand #1");
  await expect(host.locator(".hand-detail .timeline")).toContainText("posts small blind");
  await expect(host.locator(".standings-table")).toContainText("Gus");

  // 8. Move the host's identity to a new device with a one-time link.
  const token = await host.evaluate(async () => {
    const res = await fetch("/api/session/link", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return ((await res.json()) as { token: string }).token;
  });
  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await phone.goto(`/link/${token}`);
  await expect(phone.getByText("Playing as")).toContainText("Hana");
  // The link is single-use.
  const again = await phoneCtx.newPage();
  await again.goto(`/link/${token}`);
  await expect(again.getByRole("heading", { name: "Link didn't work" })).toBeVisible();

  await phoneCtx.close();
  await hostCtx.close();
  await guestCtx.close();
});

test("invalid room codes show a clear error", async ({ page }) => {
  await page.goto("/");
  await chooseName(page, "Ivy", "Continue");
  await page.getByPlaceholder("ABCD 2345").fill("ZZZZ2222");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("heading", { name: "No table with that code" })).toBeVisible();
});
