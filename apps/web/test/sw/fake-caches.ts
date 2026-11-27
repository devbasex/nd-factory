// Cache Storage の代わり。このテストが使う口だけを持つ

export function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    return {
      match: async (path: string) => store.get(path)?.clone(),
      put: async (path: string, response: Response) => void store.set(path, response),
      addAll: async (requests: Request[]) => {
        for (const request of requests) store.set(new URL(request.url).pathname, new Response(new URL(request.url).pathname));
      },
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  return { stores, caches: caches as unknown as CacheStorage };
}

export const CONFIG = (clientId: string) => ({
  api_url: "https://api.example.invalid",
  authority: "https://auth.example.invalid",
  client_id: clientId,
  login_ready: true,
});
