import { expect, test } from "@playwright/test";

test("create an account, log out, and log back in on another device", async ({ browser }) => {
  const username = `e2e_${Date.now().toString(36)}`;
  const password = "e2e-test-password";

  const laptop = await (await browser.newContext()).newPage();
  await laptop.goto("/");
  await laptop.getByRole("tab", { name: "Create account" }).click();
  await laptop.getByLabel("Name at the table (optional)").fill("Riya");
  await laptop.getByLabel("Username (for logging in)").fill(username);
  await laptop.getByLabel("Password (8+ characters)").fill(password);
  await laptop.getByLabel("Confirm password").fill(password);
  await laptop.getByRole("button", { name: "Create account" }).click();
  await expect(laptop.getByText("Signed in as")).toContainText("Riya");
  await expect(laptop.getByRole("link", { name: `@${username}` })).toBeVisible();

  // Taken usernames are refused.
  const other = await (await browser.newContext()).newPage();
  await other.goto("/");
  await other.getByRole("tab", { name: "Create account" }).click();
  await other.getByLabel("Username (for logging in)").fill(username.toUpperCase());
  await other.getByLabel("Password (8+ characters)").fill(password);
  await other.getByLabel("Confirm password").fill(password);
  await other.getByRole("button", { name: "Create account" }).click();
  await expect(other.getByRole("alert")).toContainText("taken");

  // A wrong password is refused, the right one signs in as the same player.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await phone.goto("/account");
  await phone.getByLabel("Username").fill(username);
  await phone.getByLabel("Password").fill("not-the-password");
  await phone.getByRole("button", { name: "Log in" }).click();
  await expect(phone.getByRole("alert")).toContainText("Wrong username or password");
  await phone.getByLabel("Password").fill(password);
  await phone.getByRole("button", { name: "Log in" }).click();
  await expect(phone.getByText("Signed in as")).toContainText("Riya");

  // History and stats belong to the account.
  await phone.goto("/history");
  await expect(phone.getByRole("heading", { name: "History" })).toBeVisible();

  // Logging out on the laptop returns it to the sign-in choices.
  await laptop.goto("/account");
  await laptop.getByRole("button", { name: "Log out" }).click();
  await expect(laptop.getByRole("tab", { name: "Log in" })).toBeVisible();
});
