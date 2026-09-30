import type { Config } from '../../config.js';
import type { AIProvider } from '../types.js';
import { GeminiProvider } from './gemini1.js';
export function gemini2(c: Config): AIProvider | undefined { return c.GEMINI_API_KEY_2 ? new GeminiProvider('gemini2',c.GEMINI_API_KEY_2,c) : undefined; }
