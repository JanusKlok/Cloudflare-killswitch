// workers-types declares EmailMessage as an interface (not constructable).
// This global const declaration lets us use `new EmailMessage(...)` at runtime.
declare const EmailMessage: new (from: string, to: string, raw: ReadableStream) => EmailMessage;
