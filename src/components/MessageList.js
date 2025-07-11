import React, { useEffect, useState, useRef, useContext } from "react";
import { db, auth, storage } from "../firebase";
import { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp, doc, getDoc, deleteDoc } from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { useNotifications } from "./NotificationSystem";
import { AvatarShapeContext } from "./SettingsModal";

const statusColors = {
  online: "bg-green-500",
  busy: "bg-red-500",
  away: "bg-yellow-400",
  offline: "bg-gray-400"
};

export default function MessageList({ channelId, serverOwner, serverAdmins }) {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState({});
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTaskRef, setUploadTaskRef] = useState(null);
  const [showUploadCanceled, setShowUploadCanceled] = useState(false);
  const user = auth.currentUser;
  const bottomRef = useRef(null);
  const { addNotification } = useNotifications();
  const lastMessageTimeRef = useRef(null);
  const [messageToDelete, setMessageToDelete] = useState(null);
  const avatarShape = useContext(AvatarShapeContext);

  useEffect(() => {
    if (!channelId) return;
    const q = query(
      collection(db, "messages"),
      where("channelId", "==", channelId),
      orderBy("createdAt", "asc")
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setMessages(msgs);
      setLoading(false);
      
      console.log('Messages de salon actuels:', msgs.length);
      
      // Détecter les nouveaux messages en utilisant le timestamp
      if (msgs.length > 0) {
        const latestMessage = msgs[msgs.length - 1];
        const messageTime = latestMessage.createdAt?.toDate?.() || new Date();
        
        if (lastMessageTimeRef.current && messageTime > lastMessageTimeRef.current) {
          console.log('Nouveau message de salon détecté par timestamp');
          console.log('Message:', latestMessage);
          console.log('Auteur:', latestMessage.authorId, 'Utilisateur actuel:', user?.uid);
          
          if (latestMessage.authorId !== user?.uid) {
            const authorProfile = profiles[latestMessage.authorId] || {};
            console.log('Notification pour message de:', authorProfile.pseudo || latestMessage.author);
            addNotification('message', {
              title: `Nouveau message de ${authorProfile.pseudo || latestMessage.author}`,
              body: latestMessage.content || 'Fichier envoyé',
              soundType: 'message'
            });
          } else {
            console.log('Message de l\'utilisateur actuel, pas de notification');
          }
        }
        
        lastMessageTimeRef.current = messageTime;
      }
      
      // Récupérer les profils des auteurs
      const uids = Array.from(new Set(msgs.map(m => m.authorId)));
      Promise.all(uids.map(async uid => {
        const snap = await getDoc(doc(db, "users", uid));
        return { uid, data: snap.exists() ? snap.data() : {} };
      })).then(arr => {
        const profs = {};
        arr.forEach(({ uid, data }) => { profs[uid] = data; });
        setProfiles(profs);
      });
    });
    return () => unsub();
  }, [channelId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!newMessage.trim()) return;
    await addDoc(collection(db, "messages"), {
      content: newMessage,
      channelId,
      author: user.email,
      authorId: user.uid,
      createdAt: serverTimestamp(),
    });
    setNewMessage("");
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const fileRef = ref(storage, `channelFiles/${channelId}/${Date.now()}_${file.name}`);
      const uploadTask = uploadBytesResumable(fileRef, file);
      setUploadTaskRef(uploadTask);
      uploadTask.on('state_changed',
        (snapshot) => {
          const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
          setUploadProgress(progress);
        },
        (err) => {
          if (err.code === 'storage/canceled') {
            setShowUploadCanceled(true);
          } else {
            alert("Erreur lors de l'envoi du fichier");
          }
          setUploading(false);
          setUploadTaskRef(null);
        },
        async () => {
          try {
            const url = await getDownloadURL(uploadTask.snapshot.ref);
            await addDoc(collection(db, "messages"), {
              fileUrl: url,
              fileName: file.name,
              fileType: file.type,
              channelId,
              author: user.email,
              authorId: user.uid,
              createdAt: serverTimestamp(),
              content: "",
            });
            setUploading(false);
            setUploadProgress(0);
            setUploadTaskRef(null);
          } catch (error) {
            console.error("Erreur finalisation upload:", error);
            setUploading(false);
            setUploadTaskRef(null);
          }
        }
      );
    } catch (err) {
      console.error("Erreur lors de l'envoi du fichier:", err);
      alert("Erreur lors de l'envoi du fichier");
      setUploading(false);
      setUploadTaskRef(null);
    }
    e.target.value = "";
  };

  const handleCancelUpload = () => {
    if (uploadTaskRef) {
      uploadTaskRef.cancel();
      setUploading(false);
      setUploadProgress(0);
      setUploadTaskRef(null);
    }
  };

  const downloadFile = async (fileUrl, fileName) => {
    try {
      const response = await fetch(fileUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Erreur lors du téléchargement:", error);
      alert("Erreur lors du téléchargement du fichier");
    }
  };

  const canDelete = (msg) => {
    if (!user) return false;
    return msg.authorId === user.uid || user.uid === serverOwner || (serverAdmins && serverAdmins.includes(user.uid));
  };

  const handleDeleteMessage = async () => {
    if (!messageToDelete) return;
    try {
      await deleteDoc(doc(db, "messages", messageToDelete));
      setMessageToDelete(null);
    } catch (error) {
      alert("Erreur lors de la suppression du message");
    }
  };

  if (!channelId) return null;

  return (
    <div className="w-full flex flex-col h-full bg-gray-900 bg-opacity-60 rounded-xl shadow-lg">
      <div className="flex-1 overflow-y-auto p-4 space-y-2 hide-scrollbar">
        {loading ? (
          <div className="text-purple-200">Chargement...</div>
        ) : messages.length === 0 ? (
          <div className="text-purple-300">Aucun message pour l'instant.</div>
        ) : (
          messages.map(msg => {
            const p = profiles[msg.authorId] || {};
            let roleEmoji = "👤";
            if (msg.authorId === serverOwner) roleEmoji = "👑";
            else if (serverAdmins && serverAdmins.includes(msg.authorId)) roleEmoji = "🛡️";
            return (
              <div key={msg.id} className={`flex gap-2 items-start ${msg.authorId === user.uid ? 'justify-end' : ''}`}>
                {msg.authorId !== user.uid && (
                  <div className="relative">
                    <img
                      src={p.avatar || `https://api.dicebear.com/7.x/thumbs/svg?seed=${msg.authorId}`}
                      alt="avatar"
                      className={`w-8 h-8 object-cover border-2 border-indigo-500 ${avatarShape === 'round' ? 'rounded-full' : 'rounded'}`}
                    />
                    <span className={`absolute bottom-0 right-0 w-2 h-2 rounded-full border-2 border-gray-900 ${statusColors[p.status] || 'bg-gray-400'}`}></span>
                  </div>
                )}
                <div className={`p-2 rounded max-w-[70%] ${msg.authorId === user.uid ? 'bg-indigo-700 text-right ml-10' : 'bg-gray-800 text-left mr-2'}`}
                  style={{ position: 'relative' }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">{roleEmoji}</span>
                    <span className="font-semibold text-sm text-purple-200">{p.pseudo || msg.author}</span>
                    <span className="text-xs text-purple-400 opacity-60">{msg.createdAt?.toDate ? msg.createdAt.toDate().toLocaleTimeString() : ''}</span>
                    {canDelete(msg) && (
                      <button
                        onClick={() => setMessageToDelete(msg.id)}
                        title="Supprimer le message"
                        className="ml-2 text-red-400 hover:text-red-600 text-lg focus:outline-none"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                  <div className="text-base break-words">
                    {msg.fileUrl ? (
                      msg.fileType && msg.fileType.startsWith('image/') ? (
                        <div>
                          <img 
                            src={msg.fileUrl} 
                            alt={msg.fileName} 
                            className="max-w-[200px] max-h-[200px] rounded mb-1" 
                            onError={(e) => {
                              e.target.style.display = 'none';
                              e.target.nextSibling.textContent = '❌ Image non disponible';
                            }}
                          />
                          <button 
                            onClick={() => downloadFile(msg.fileUrl, msg.fileName)}
                            className="text-xs text-indigo-300 hover:text-indigo-200 underline cursor-pointer"
                          >
                            📥 {msg.fileName}
                          </button>
                        </div>
                      ) : (
                        <button 
                          onClick={() => downloadFile(msg.fileUrl, msg.fileName)}
                          className="text-indigo-300 hover:text-indigo-200 underline cursor-pointer"
                        >
                          📎 📥 {msg.fileName}
                        </button>
                      )
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
                {msg.authorId === user.uid && (
                  <div className="relative">
                    <img
                      src={p.avatar || `https://api.dicebear.com/7.x/thumbs/svg?seed=${msg.authorId}`}
                      alt="avatar"
                      className={`w-8 h-8 object-cover border-2 border-indigo-500 ${avatarShape === 'round' ? 'rounded-full' : 'rounded'}`}
                    />
                    <span className={`absolute bottom-0 right-0 w-2 h-2 rounded-full border-2 border-gray-900 ${statusColors[p.status] || 'bg-gray-400'}`}></span>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
      {showUploadCanceled && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-70">
          <div className="bg-gray-900 rounded-xl p-8 shadow-xl flex flex-col items-center max-w-sm w-full">
            <div className="text-lg text-purple-300 font-bold mb-4">Envoi annulé</div>
            <div className="text-purple-200 mb-6 text-center">L'envoi du fichier a été annulé.</div>
            <button
              onClick={() => setShowUploadCanceled(false)}
              className="bg-indigo-600 hover:bg-indigo-700 px-6 py-2 rounded text-white font-bold"
            >OK</button>
          </div>
        </div>
      )}
      {/* Overlay de confirmation suppression message */}
      {messageToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-70">
          <div className="bg-gray-900 rounded-xl p-8 shadow-xl flex flex-col items-center max-w-sm w-full">
            <div className="text-lg text-red-400 font-bold mb-4">Supprimer le message ?</div>
            <div className="text-purple-200 mb-6 text-center">Cette action est <b>irréversible</b>.<br/>Le message sera définitivement supprimé.</div>
            <div className="flex gap-3 w-full">
              <button
                onClick={handleDeleteMessage}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded font-semibold"
              >Supprimer</button>
              <button
                onClick={() => setMessageToDelete(null)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded font-semibold"
              >Annuler</button>
            </div>
          </div>
        </div>
      )}
      <form onSubmit={handleSendMessage} className="flex gap-2 p-3 border-t border-gray-800 bg-gray-900 rounded-b-xl">
        <label className="flex items-center cursor-pointer">
          <span className="text-2xl px-2 text-purple-300 hover:text-white">📎</span>
          <input type="file" className="hidden" onChange={handleFileChange} disabled={uploading} />
        </label>
        <input
          type="text"
          placeholder="Écrire un message..."
          value={newMessage}
          onChange={e => setNewMessage(e.target.value)}
          className="flex-1 px-3 py-2 rounded bg-gray-800 text-white border border-gray-700 focus:outline-none"
          disabled={uploading}
        />
        <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded text-white font-semibold" disabled={uploading}>Envoyer</button>
        {uploading && (
          <div className="flex items-center gap-2 ml-2 w-40">
            <div className="flex-1 h-2 bg-gray-700 rounded">
              <div className="h-2 bg-indigo-500 rounded" style={{ width: `${uploadProgress}%` }}></div>
            </div>
            <span className="text-xs text-purple-200 w-8 text-right">{uploadProgress}%</span>
            <button
              type="button"
              onClick={handleCancelUpload}
              className="ml-2 text-xs bg-red-600 hover:bg-red-700 text-white px-2 py-1 rounded"
            >Annuler</button>
          </div>
        )}
      </form>
    </div>
  );
} 