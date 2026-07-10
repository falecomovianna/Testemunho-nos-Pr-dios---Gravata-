import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getStorage, ref, uploadString, getDownloadURL } from 'firebase/storage';
import * as firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig as any);

// Ativa uma "memória" local (cache) do banco de dados, guardada no próprio
// navegador. Isso faz o app abrir bem mais rápido nas próximas vezes e evita
// ter que baixar a lista inteira de prédios do zero a cada abertura — o que
// economiza bastante da cota gratuita. Se o navegador não suportar esse
// recurso por algum motivo (bem raro), cai automaticamente no modo padrão,
// sem quebrar nada.
let dbInstance;
try {
  dbInstance = initializeFirestore(
    app,
    { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) },
    (firebaseConfig as any).firestoreDatabaseId
  );
} catch (err) {
  console.warn('Cache local não disponível, usando modo padrão:', err);
  dbInstance = getFirestore(app, (firebaseConfig as any).firestoreDatabaseId);
}
export const db = dbInstance;

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
