/**
 * The AI layer.
 *
 * `groq-client` is the only thing here that makes a network request; everything else either
 * builds a prompt for it, validates what comes back, or records where a value came from.
 */
export * from './credentials';
export * from './groq-client';
export * from './prompts';
export * from './provenance';
export * from './run-outcome';
export * from './semantic-assistant';
export * from './case-analysis';
