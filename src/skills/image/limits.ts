/** Shared image Skill limits. Change this object to adjust the first release policy. */
export const IMAGE_GENERATION_LIMITS = Object.freeze({
    perMemberPerGroupDaily: 3,
    imagesPerRequest: 1,
    globalConcurrency: 1,
    requestTimeoutMs: 120_000,
    maxImageBytes: 30 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    maxImageEdge: 8_192,
    maxPromptCharacters: 32_000,
});
