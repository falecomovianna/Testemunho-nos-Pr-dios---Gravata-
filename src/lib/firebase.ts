import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import { getStorage, ref, uploadString, getDownloadURL } from 'firebase/storage';
import * as firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig as any);
export const db = getFirestore(app, (firebaseConfig as any).firestoreDatabaseId);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);
export const logout = () => auth.signOut();

// Sobe a foto da fachada para o Firebase Storage (fora do banco de dados),
// e devolve o link (URL) para ser salvo no documento do prédio.
// Se der qualquer erro (ex: Storage não habilitado no projeto), quem chamar
// essa função deve capturar o erro e usar a imagem em base64 como já era feito antes.
export async function uploadFacadeImage(buildingId: string, base64DataUrl: string): Promise<string> {
  const imageRef = ref(storage, `facades/${buildingId}.jpg`);
  await uploadString(imageRef, base64DataUrl, 'data_url');
  return await getDownloadURL(imageRef);
}

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
