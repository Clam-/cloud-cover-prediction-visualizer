interface PersistentCacheEntry<T> {
  key: string;
  value: T;
  expiresAt: number;
  createdAt: number;
}

interface CacheWrite<T> {
  key: string;
  value: T;
}

const DB_NAME = "horizon-data-cache";
const DB_VERSION = 1;
const STORE_NAME = "entries";
const CACHED_AT_HEADER = "x-horizon-cached-at";

let databasePromise: Promise<IDBDatabase | undefined> | undefined;

export async function readPersistentCache<T>(key: string): Promise<T | undefined> {
  const values = await readPersistentCacheMany<T>([key]);
  return values.get(key);
}

export async function writePersistentCache<T>(key: string, value: T, ttlMs: number): Promise<void> {
  await writePersistentCacheMany([{ key, value }], ttlMs);
}

export async function readPersistentCacheMany<T>(keys: string[]): Promise<Map<string, T>> {
  const database = await openDatabase();
  const values = new Map<string, T>();
  if (!database || keys.length === 0) {
    return values;
  }

  const now = Date.now();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        const entry = request.result as PersistentCacheEntry<T> | undefined;
        if (!entry) {
          return;
        }
        if (entry.expiresAt <= now) {
          store.delete(key);
          return;
        }
        values.set(key, entry.value);
      };
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cache read failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Cache read aborted"));
  }).catch(() => undefined);

  return values;
}

export async function writePersistentCacheMany<T>(entries: CacheWrite<T>[], ttlMs: number): Promise<void> {
  const database = await openDatabase();
  if (!database || entries.length === 0) {
    return;
  }

  const createdAt = Date.now();
  const expiresAt = createdAt + ttlMs;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    for (const entry of entries) {
      store.put({
        key: entry.key,
        value: entry.value,
        expiresAt,
        createdAt
      } satisfies PersistentCacheEntry<T>);
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cache write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Cache write aborted"));
  }).catch(() => undefined);
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function loadCachedJson<T>(cacheKey: string, ttlMs: number, url: string, signal: AbortSignal | undefined, label: string): Promise<T> {
  return loadCached(cacheKey, ttlMs, url, signal, label, (response) => response.json() as Promise<T>);
}

export async function loadCachedText(cacheKey: string, ttlMs: number, url: string, signal: AbortSignal | undefined, label: string): Promise<string> {
  return loadCached(cacheKey, ttlMs, url, signal, label, (response) => response.text());
}

async function loadCached<T>(
  cacheKey: string,
  ttlMs: number,
  url: string,
  signal: AbortSignal | undefined,
  label: string,
  parse: (response: Response) => Promise<T>
): Promise<T> {
  throwIfAborted(signal);
  const cached = await readPersistentCache<T>(cacheKey);
  if (cached) {
    return cached;
  }
  throwIfAborted(signal);

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}`);
  }
  const body = await parse(response);
  await writePersistentCache(cacheKey, body, ttlMs);
  return body;
}

export async function fetchCachedBlob(cacheName: string, url: string, ttlMs: number, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  if (!("caches" in window)) {
    return fetchBlob(url, signal);
  }

  let cache: Cache | undefined;
  try {
    cache = await caches.open(cacheName);
    const cached = await cache.match(url);
    if (cached && !isCachedResponseExpired(cached, ttlMs)) {
      return cached.blob();
    }
    if (cached) {
      await cache.delete(url);
    }
  } catch {
    cache = undefined;
  }

  const { blob, contentType } = await fetchBlobWithContentType(url, signal);
  if (cache) {
    const headers = new Headers();
    if (contentType) {
      headers.set("content-type", contentType);
    }
    headers.set(CACHED_AT_HEADER, String(Date.now()));
    await cache.put(url, new Response(blob, { headers })).catch(() => undefined);
  }
  return blob;
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (!("indexedDB" in window)) {
    return Promise.resolve(undefined);
  }
  databasePromise ??= new Promise<IDBDatabase | undefined>((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
  return databasePromise;
}

function isCachedResponseExpired(response: Response, ttlMs: number): boolean {
  const cachedAt = Number(response.headers.get(CACHED_AT_HEADER));
  return !Number.isFinite(cachedAt) || Date.now() - cachedAt > ttlMs;
}

async function fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const { blob } = await fetchBlobWithContentType(url, signal);
  return blob;
}

async function fetchBlobWithContentType(url: string, signal?: AbortSignal): Promise<{ blob: Blob; contentType: string | null }> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Request returned ${response.status}`);
  }
  return {
    blob: await response.blob(),
    contentType: response.headers.get("content-type")
  };
}
