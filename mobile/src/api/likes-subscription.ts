type LikedItemsListener = () => void;

const listeners = new Set<LikedItemsListener>();

export function subscribeLikedItems(listener: LikedItemsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyLikedItemsChanged(): void {
  listeners.forEach((listener) => listener());
}
