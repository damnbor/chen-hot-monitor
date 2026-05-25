const STORAGE_KEY = 'hotpulse_search_history';
const MAX_ENTRIES = 50;

export interface SearchHistoryEntry {
  query: string;
  timestamp: number;
  resultCount: number;
  timedOut?: boolean;
  completedSources?: string[];
}

function readHistory(): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHistory(entries: SearchHistoryEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

export function getSearchHistory(): SearchHistoryEntry[] {
  return readHistory();
}

export function addSearchHistory(entry: Omit<SearchHistoryEntry, 'timestamp'> & { timestamp?: number }) {
  const history = readHistory().filter(h => h.query.toLowerCase() !== entry.query.toLowerCase());
  history.unshift({
    ...entry,
    timestamp: entry.timestamp ?? Date.now()
  });
  writeHistory(history);
}

export function removeSearchHistory(query: string) {
  writeHistory(readHistory().filter(h => h.query.toLowerCase() !== query.toLowerCase()));
}

export function clearSearchHistory() {
  localStorage.removeItem(STORAGE_KEY);
}

export function getHistorySuggestions(prefix: string, limit = 8): string[] {
  const q = prefix.trim().toLowerCase();
  if (!q) {
    return readHistory().slice(0, limit).map(h => h.query);
  }
  return readHistory()
    .filter(h => h.query.toLowerCase().includes(q))
    .slice(0, limit)
    .map(h => h.query);
}
