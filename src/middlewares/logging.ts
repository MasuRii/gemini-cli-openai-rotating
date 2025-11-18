import { Next } from "hono";
import { AppContext } from "../types";
import { AuthManager } from "../auth";
import { createLogger, generateTraceId } from "../utils/logger";

/**
 * Logging middleware for request/response tracking
 *
 * Logs:
 * - Request start with method, path, and body (for POST/PUT/PATCH)
 * - Request completion with status code and duration
 * - Masks sensitive data in request bodies
 *
 * Uses structured logger with trace ID for request tracking
 */
export const loggingMiddleware = async (c: AppContext, next: Next) => {
	const method = c.req.method;
	const path = c.req.path;
	const startTime = Date.now();
	const startTimeMs = performance.now(); // High precision timing

	// Generate unique trace ID for this request
	const traceId = generateTraceId();
	
	// Create logger instance with trace ID
	const logger = createLogger(c.env, traceId);
	
	// Attach logger and traceId to context
	c.set("logger", logger);
	c.set("traceId", traceId);

	// Get available accounts metric for this request
	let accountsMetric = "";
	try {
		const authManager = new AuthManager(c.env);
		const accountsMetricData = await authManager.getAccountsMetric();
		accountsMetric = ` [${accountsMetricData.available}/${accountsMetricData.total} available accounts]`;
	} catch (error) {
		logger.warn("AUTHENTICATION", "Failed to calculate accounts metric", { error: error instanceof Error ? error.message : String(error) });
	}

	// Log request body for POST/PUT/PATCH requests
	let bodyLog = "";
	if (["POST", "PUT", "PATCH"].includes(method)) {
		try {
			// Clone the request to read the body without consuming it
			const clonedReq = c.req.raw.clone();
			const body = await clonedReq.text();

			// Truncate very long bodies and mask sensitive data
			const truncatedBody = body.length > 500 ? body.substring(0, 500) + "..." : body;
			// Mask potential API keys or tokens
			const maskedBody = truncatedBody.replace(/"(api_?key|token|authorization)":\s*"[^"]*"/gi, '"$1": "***"');
			bodyLog = ` - Body: ${maskedBody}`;
		} catch {
			bodyLog = " - Body: [unable to parse]";
		}
	}

	logger.info("REQUEST", "Request started", {
		method,
		path,
		accountsMetric,
		bodyLog
	});

	await next();

	const duration = Date.now() - startTime;
	const endTimeMs = performance.now();
	const preciseDuration = endTimeMs - startTimeMs; // High precision duration in milliseconds
	const status = c.res.status;

	logger.info("REQUEST", "Request completed", {
		method,
		path,
		status,
		duration,
		preciseDuration,
		accountsMetric
	});
};
