import AsyncStorage from '@react-native-async-storage/async-storage';

import type { KeyValueStore } from './key-value-store';

/**
 * AsyncStorage-backed key/value store.
 *
 * This is the only file in the data layer that imports a React Native module, which
 * is what keeps the rest of it runnable under Node.
 */
export function createAsyncStorageStore(): KeyValueStore {
  return {
    async get(key) {
      return AsyncStorage.getItem(key);
    },
    async getMany(keys) {
      if (!keys.length) return [];
      const entries = await AsyncStorage.multiGet([...keys]);
      return entries.map(([key, value]) => [key, value ?? null] as [string, string | null]);
    },
    async setMany(entries) {
      if (!entries.length) return;
      await AsyncStorage.multiSet(entries.map(([key, value]) => [key, value]));
    },
    async remove(keys) {
      if (!keys.length) return;
      await AsyncStorage.multiRemove([...keys]);
    },
    async keys() {
      return [...(await AsyncStorage.getAllKeys())];
    },
  };
}
