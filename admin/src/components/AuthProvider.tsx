"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { getFirebaseAuth, googleProvider } from "@/lib/firebase";

const ADMIN_EMAIL = "adnan@thothica.com";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isAuthorized: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  isAuthorized: false,
  signIn: async () => {},
  signOut: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const isAuthorized = user?.email === ADMIN_EMAIL;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), async (firebaseUser) => {
      if (firebaseUser && firebaseUser.email !== ADMIN_EMAIL) {
        // Unauthorized user -- sign them out immediately
        await firebaseSignOut(getFirebaseAuth());
        setUser(null);
      } else {
        setUser(firebaseUser);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = async () => {
    try {
      const result = await signInWithPopup(getFirebaseAuth(), googleProvider);
      if (result.user.email !== ADMIN_EMAIL) {
        await firebaseSignOut(getFirebaseAuth());
        setUser(null);
        alert("Unauthorized. Only the admin account can access this app.");
      }
    } catch (error) {
      console.error("Sign-in error:", error);
    }
  };

  const signOut = async () => {
    await firebaseSignOut(getFirebaseAuth());
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, isAuthorized, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
