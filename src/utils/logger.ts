// Custom structured logger for GeminiCLIOpenAIRotation
// Supports both human-readable console output and machine-parseable JSON output

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogEntry {
	timestamp: string; // ISO 8601 format
	level: LogLevel;
	category: string;
	message: string;
	traceId: string;
	details?: Record<string, unknown>;
}

export interface LoggerConfig {
	level: LogLevel;
	format: "console" | "json";
	traceId: string;
}

// ANSI color codes for console output
const ANSI_COLORS = {
	RESET: "\x1b[0m",
	BRIGHT: "\x1b[1m",
	RED: "\x1b[31m",
	GREEN: "\x1b[32m",
	YELLOW: "\x1b[33m",
	BLUE: "\x1b[34m",
	MAGENTA: "\x1b[35m",
	CYAN: "\x1b[36m",
	GRAY: "\x1b[90m",
} as const;

// Color mapping for log levels
const LOG_LEVEL_COLORS = {
	DEBUG: ANSI_COLORS.GRAY,
	INFO: ANSI_COLORS.GREEN,
	WARN: ANSI_COLORS.YELLOW,
	ERROR: ANSI_COLORS.RED,
} as const;

/**
 * Logger class that supports both console and JSON output formats
 */
export class Logger {
	private config: LoggerConfig;

	constructor(config: LoggerConfig) {
		this.config = config;
	}

	private shouldLog(level: LogLevel): boolean {
		const levels: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];
		const configLevelIndex = levels.indexOf(this.config.level);
		const messageLevelIndex = levels.indexOf(level);
		return messageLevelIndex >= configLevelIndex;
	}

	private createLogEntry(
		level: LogLevel,
		category: string,
		message: string,
		details?: Record<string, unknown>
	): LogEntry {
		return {
			timestamp: new Date().toISOString(),
			level,
			category,
			message,
			traceId: this.config.traceId,
			details,
		};
	}

	private formatConsoleOutput(entry: LogEntry): string {
		const color = LOG_LEVEL_COLORS[entry.level];
		const reset = ANSI_COLORS.RESET;
		const bright = ANSI_COLORS.BRIGHT;

		return `${color}[${entry.timestamp}] ${entry.level}${reset} ${bright}[${entry.category}]${reset} ${entry.message} ${color}{traceId: ${entry.traceId}}${reset}${entry.details ? ` ${JSON.stringify(entry.details)}` : ""}`;
	}

	private formatJsonOutput(entry: LogEntry): string {
		return JSON.stringify(entry);
	}

	private output(level: LogLevel, category: string, message: string, details?: Record<string, unknown>): void {
		if (!this.shouldLog(level)) {
			return;
		}

		const entry = this.createLogEntry(level, category, message, details);
		const formattedOutput = this.config.format === "json" 
			? this.formatJsonOutput(entry) 
			: this.formatConsoleOutput(entry);

		switch (level) {
			case "DEBUG":
				console.debug(formattedOutput);
				break;
			case "INFO":
				console.info(formattedOutput);
				break;
			case "WARN":
				console.warn(formattedOutput);
				break;
			case "ERROR":
				console.error(formattedOutput);
				break;
		}
	}

	/**
	 * Log a debug message
	 */
	debug(category: string, message: string, details?: Record<string, unknown>): void {
		this.output("DEBUG", category, message, details);
	}

	/**
	 * Log an info message
	 */
	info(category: string, message: string, details?: Record<string, unknown>): void {
		this.output("INFO", category, message, details);
	}

	/**
	 * Log a warning message
	 */
	warn(category: string, message: string, details?: Record<string, unknown>): void {
		this.output("WARN", category, message, details);
	}

	/**
	 * Log an error message
	 */
	error(category: string, message: string, details?: Record<string, unknown>): void {
		this.output("ERROR", category, message, details);
	}

	/**
	 * Get the current trace ID
	 */
	getTraceId(): string {
		return this.config.traceId;
	}

	/**
	 * Create a child logger with additional context
	 */
	child(_: Record<string, unknown>): Logger {
		return new Logger({
			...this.config,
		});
	}
}

/**
 * Create a logger instance from environment variables
 */
export function createLogger(env: { LOG_FORMAT?: string; LOG_LEVEL?: string }, traceId: string): Logger {
	const format = (env.LOG_FORMAT as "console" | "json") || "console";
	const level = (env.LOG_LEVEL as LogLevel) || "INFO";

	return new Logger({
		format,
		level,
		traceId,
	});
}

/**
 * Generate a unique trace ID for request tracking
 */
export function generateTraceId(): string {
	// Use crypto.randomUUID() if available (Cloudflare Workers), fallback to Math.random()
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return Math.random().toString(36).substring(2) + Date.now().toString(36);
}