// 期限を測る時計と待ちの既定（本番の値）。試しは options の now・sleep で差し替える
export const defaultNow = (): number => performance.now();

export const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
