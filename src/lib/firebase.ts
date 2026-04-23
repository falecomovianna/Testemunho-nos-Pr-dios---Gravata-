import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import * as firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig as any);
export const db = getFirestore(app, (firebaseConfig as any).firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);
export const logout = () => auth.signOut();

// Connection test
async function testConnection() {
  try {
    // Access a dummy doc to verify connection
    await getDocFromServer(doc(db, '_internal_', 'startup_check'));
    console.log("Firebase connection established.");
  } catch (error: any) {
    if (error.message && error.message.includes('the client is offline')) {
      console.error("Firebase is offline. Check configuration.");
    }
  }
}
testConnection();
