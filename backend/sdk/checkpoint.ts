import { promises as fs } from 'node:fs';
import type { BudgetUsage, CheckpointData, OpenRouterMessage } from './types.js';

export class CheckpointManager {
  private readonly filePath: string;

  constructor(options?: { path?: string }) {
    this.filePath = options?.path ?? './.agent-checkpoint.json';
  }

  async save(
    messages: OpenRouterMessage[],
    usage: BudgetUsage,
    model: string,
    resumeFromStep: number,
  ): Promise<void> {
    const data: CheckpointData = {
      checkpointVersion: '1.0',
      messages,
      usage,
      model,
      resumeFromStep,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async load(): Promise<CheckpointData | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as CheckpointData;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch {
      // File may not exist — ignore
    }
  }
}
