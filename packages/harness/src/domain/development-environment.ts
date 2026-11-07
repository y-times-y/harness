/**
 * Development-only switches pass only where the deployment says it is
 * development: `YTIMESY_ENVIRONMENT=development`. Unset is not development,
 * so a deployment that forgets the variable gets production behaviour.
 * scripts/deploy-edge-development.ts, scripts/development-server.ts and the
 * eval scripts (scripts/smoke/eval-user.ts) set it.
 */
export function isDevelopmentEnvironment(
	env: { readonly YTIMESY_ENVIRONMENT?: string } = process.env,
): boolean {
	return env.YTIMESY_ENVIRONMENT === "development";
}
