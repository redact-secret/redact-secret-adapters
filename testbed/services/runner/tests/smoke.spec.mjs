// Trivial browser smoke (#192). Detailed journeys are #196; each phase adds its own *.spec.mjs here.
import { expect, test } from "@playwright/test";

test("the scenario UI lists the fixed smoke scenarios and runs one", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Adapter consumer testbed" })).toBeVisible();
  const row = page.locator('[data-scenario="smoke.node-public-imports"]');
  await expect(row).toBeVisible();
  await row.getByTestId("run").click();
  await expect(row.getByTestId("status")).toHaveText("pass");
});
