import type { Database } from 'firebase/database';

// Same Firebase project as Fairway Legends (fairway-legends-51e70). These values are public by
// design: they identify the project; access is governed by the database rules, which live in
// the fairway-ledgends repo (database.rules.json, under "kc").
const firebaseConfig = {
  apiKey: 'AIzaSyC8tS4f44d0JrdJX1c7mjEtpYL69ZvwhMs',
  authDomain: 'fairway-legends-51e70.firebaseapp.com',
  databaseURL: 'https://fairway-legends-51e70-default-rtdb.firebaseio.com',
  projectId: 'fairway-legends-51e70',
  storageBucket: 'fairway-legends-51e70.firebasestorage.app',
  messagingSenderId: '395979382474',
  appId: '1:395979382474:web:c16ef4667332e4773f9e33',
};

let dbPromise: Promise<Database> | null = null;

/** The Realtime Database, loaded on first use so the SDK isn't in the main bundle. */
export function getDb(): Promise<Database> {
  dbPromise ??= (async () => {
    const [{ initializeApp }, { getDatabase }] = await Promise.all([import('firebase/app'), import('firebase/database')]);
    return getDatabase(initializeApp(firebaseConfig, 'kitchen-clash'));
  })();
  return dbPromise;
}
