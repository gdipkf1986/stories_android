import { NativeModule, requireNativeModule } from 'expo';

declare class ShareReceiverModule extends NativeModule<{}> {
  takeSharedText(): string | null;
  takeSharedTitle(): string | null;
}

export default requireNativeModule<ShareReceiverModule>('ShareReceiver');
