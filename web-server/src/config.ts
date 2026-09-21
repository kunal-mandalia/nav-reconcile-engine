export function backendMode(args: string[], env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV === "production")
    throw new Error(
      "Demo identity is local-only and cannot run with NODE_ENV=production.",
    );
  const mock = args.includes("--mock");
  const service = args.includes("--service");
  if (mock && service)
    throw new Error("Choose only one of --mock or --service.");
  // Explicit development scripts override the Docker/default environment setting.
  const mode = mock
    ? "mock"
    : service
      ? "fund-service"
      : env.CLIENT_API_BACKEND;
  if (mode !== "mock" && mode !== "fund-service")
    throw new Error(
      "Set CLIENT_API_BACKEND=mock or fund-service, or choose --mock or --service.",
    );
  return mode;
}
