import { test } from "@playwright/test";

// North-star E2E contract for the pi-crust extension framework. This is skipped
// until web extension contributions are wired into the real browser UI.
test.skip("installed local pi-crust extension contributes UI, server route, command, and session behavior", async ({ page: _page }) => {
  // Intended flow:
  // 1. create isolated pi-crust home/config/project/session dirs;
  // 2. write local package with piRemoteControl extension manifest;
  // 3. run `pi-crust install ./package` or equivalent harness command;
  // 4. start pi-crust with MockPiAdapter and temp config;
  // 5. assert extension activity button/view appears;
  // 6. assert /api/extensions/:id/ping responds;
  // 7. invoke extension command from command palette/slash command;
  // 8. assert the command can create/open a session through host APIs.
});
