// Do not reuse vite.config.ts: the React/Tailwind plugins there are for Vite 8.
// And the tests here only verify pure functions, requiring no plugins.
export default {
  test: {
    include: ["src/**/*.test.ts"],
    // In CI, write failed cases as check comments, so you can see which one failed without logging in.
    reporters: process.env["GITHUB_ACTIONS"] ? ["default", "github-actions"] : ["default"],
  },
};
