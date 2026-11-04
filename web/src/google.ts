// Google sign-in through Firebase Authentication. Loaded lazily only when the server exposes a Firebase config,
// so the main bundle stays small. The Worker verifies the resulting ID token itself.
export type FirebaseWebConfig = { apiKey: string; authDomain: string; projectId: string };

export async function googleIdToken(cfg: FirebaseWebConfig): Promise<{ idToken: string; email: string; name: string }> {
  const [{ initializeApp, getApps }, { getAuth, GoogleAuthProvider, signInWithPopup, signOut }] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
  const app = getApps()[0] ?? initializeApp(cfg);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  const idToken = await cred.user.getIdToken();
  const out = { idToken, email: cred.user.email || '', name: cred.user.displayName || '' };
  await signOut(auth); // the app keeps its own session; Firebase is only used to prove the Google identity
  return out;
}
