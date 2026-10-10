import { registerWebModule, NativeModule } from 'expo';

// ShareReceiverModule is not available on the web platform.
class ShareReceiverModule extends NativeModule<{}> {}

export default registerWebModule(ShareReceiverModule, 'ShareReceiverModule');
