export default {
  test: {
    include: ["src/**/*.test.ts"],
    // In CI, write failed cases as check comments, so you can see which one failed without logging in.
    reporters: process.env["GITHUB_ACTIONS"] ? ["default", "github-actions"] : ["default"],
  },
};
