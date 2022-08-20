import CancellationToken from "cancellationtoken";
import { Duplex } from "stream";
import { ChannelOptions } from "./ChannelOptions";
import { ControlCode } from "./ControlCode";
import { Deferred } from "./Deferred";
import { FrameHeader } from "./FrameHeader";
import { IDisposableObservable } from "./IDisposableObservable";
import { MultiplexingStreamClass, MultiplexingStream } from "./MultiplexingStream";
import { OfferParameters } from "./OfferParameters";
import { AcceptanceParameters } from "./AcceptanceParameters";
import { QualifiedChannelId, ChannelSource } from "./QualifiedChannelId";
import caught = require("caught");

export abstract class Channel implements IDisposableObservable {
    /**
     * The id of the channel.
     * @obsolete Use qualifiedId instead.
     */
    public get id(): number {
        return this.qualifiedId.id;
    }

    /**
     * The party-qualified ID of the channel.
     */
    public readonly qualifiedId: QualifiedChannelId;

    /**
     * A read/write stream used to communicate over this channel.
     */
    public abstract stream: NodeJS.ReadWriteStream;

    /**
     * A promise that completes when this channel has been accepted/rejected by the remote party.
     */
    public abstract acceptance: Promise<void>;

    /**
     * A promise that completes when this channel is closed.
     */
    public abstract completion: Promise<void>;

    private _isDisposed: boolean = false;

    constructor(id: QualifiedChannelId) {
        this.qualifiedId = id;
    }

    /**
     * Gets a value indicating whether this channel has been disposed.
     */
    public get isDisposed(): boolean {
        return this._isDisposed;
    }

    /**
     * Closes this channel. If the an error is passed into the method then that error
     * gets sent to the remote before the disposing of the channel. 
     */
    public async dispose(error? : Error) {
        // The interesting stuff is in the derived class.
        this._isDisposed = true;
    }
}

// tslint:disable-next-line:max-classes-per-file
export class ChannelClass extends Channel {
    public readonly name: string;
    private _duplex: Duplex;
    private readonly _multiplexingStream: MultiplexingStreamClass;
    private readonly _acceptance = new Deferred<void>();
    private readonly _completion = new Deferred<void>();
    public localWindowSize?: number;
    private remoteWindowSize?: number;
    private remoteError?: Error;

    /**
     * The number of bytes transmitted from here but not yet acknowledged as processed from there,
     * and thus occupying some portion of the full AcceptanceParameters.RemoteWindowSize.
     */
    private remoteWindowFilled: number = 0;

    /** A signal which indicates when the <see cref="RemoteWindowRemaining"/> is non-zero. */
    private remoteWindowHasCapacity: Deferred<void>;

    constructor(
        multiplexingStream: MultiplexingStreamClass,
        id: QualifiedChannelId,
        offerParameters: OfferParameters) {

        super(id);
        const self = this;
        this.name = offerParameters.name;
        switch (id.source) {
            case ChannelSource.Local:
                this.localWindowSize = offerParameters.remoteWindowSize;
                break;
            case ChannelSource.Remote:
                this.remoteWindowSize = offerParameters.remoteWindowSize;
                break;
            case ChannelSource.Seeded:
                this.remoteWindowSize = offerParameters.remoteWindowSize;
                this.localWindowSize = offerParameters.remoteWindowSize;
                break;
            default:
                throw new Error("Channel source not recognized.");
        }

        this._multiplexingStream = multiplexingStream;

        this.remoteWindowHasCapacity = new Deferred<void>();
        if (!this._multiplexingStream.backpressureSupportEnabled || this.remoteWindowSize) {
            this.remoteWindowHasCapacity.resolve();
        }

        this._duplex = new Duplex({
            async write(chunk, _, callback) {
                let error;
                try {
                    let payload = Buffer.from(chunk);
                    while (payload.length > 0) {
                        // Never transmit more than one frame's worth at a time.
                        let bytesTransmitted = Math.min(payload.length, MultiplexingStream.framePayloadMaxLength);

                        // Don't send more than will fit in the remote's receiving window size.
                        if (self._multiplexingStream.backpressureSupportEnabled) {
                            await self.remoteWindowHasCapacity.promise;
                            if (!self.remoteWindowSize) {
                                throw new Error("Remote window size unknown.");
                            }

                            bytesTransmitted = Math.min(self.remoteWindowSize - self.remoteWindowFilled, bytesTransmitted);
                        }

                        self.onTransmittingBytes(bytesTransmitted);
                        const header = new FrameHeader(ControlCode.Content, id);
                        await multiplexingStream.sendFrameAsync(header, payload.slice(0, bytesTransmitted));
                        payload = payload.slice(bytesTransmitted);
                    }
                } catch (err) {
                    error = err;
                }

                if (callback) {
                    callback(error);
                }
            },

            async final(cb?: (err?: any) => void) {
                let error;
                try {
                    await multiplexingStream.onChannelWritingCompleted(self);
                } catch (err) {
                    error = err;
                }

                if (cb) {
                    cb(error);
                }
            },

            read() {
                // Nothing to do here since data is pushed to us.
            },
        });
    }

    public get stream(): NodeJS.ReadWriteStream {
        return this._duplex;
    }

    public get acceptance(): Promise<void> {
        return this._acceptance.promise;
    }

    public get isAccepted() {
        return this._acceptance.isResolved;
    }

    public get isRejectedOrCanceled() {
        return this._acceptance.isRejected;
    }

    public get completion(): Promise<void> {
        return this._completion.promise;
    }

    public tryAcceptOffer(options?: ChannelOptions): boolean {
        if (this._acceptance.resolve()) {
            this.localWindowSize = options?.channelReceivingWindowSize !== undefined
                ? Math.max(this._multiplexingStream.defaultChannelReceivingWindowSize, options?.channelReceivingWindowSize)
                : this._multiplexingStream.defaultChannelReceivingWindowSize;
            return true;
        }

        return false;
    }

    public tryCancelOffer(reason: any) {
        const cancellationReason = new CancellationToken.CancellationError(reason);
        this._acceptance.reject(cancellationReason);
        this._completion.reject(cancellationReason);

        // Also mark completion's promise rejections as 'caught' since we do not require
        // or even expect it to be recognized by anyone else.
        // The acceptance promise rejection is observed by the offer channel method.
        caught(this._completion.promise);
    }

    public onAccepted(acceptanceParameter: AcceptanceParameters): boolean {
        if (this._multiplexingStream.backpressureSupportEnabled) {
            this.remoteWindowSize = acceptanceParameter.remoteWindowSize;
            this.remoteWindowHasCapacity.resolve();
        }

        return this._acceptance.resolve();
    }

    public onContent(buffer: Buffer | null, error? : Error) {
        // If we have already received an error from remote then don't process any future messages
        if (this.remoteError) {
            return; 
        }

        this.remoteError = error;
    
        this._duplex.push(buffer);

        // We should find a way to detect when we *actually* share the received buffer with the Channel's user
        // and only report consumption when they receive the buffer from us so that we effectively apply
        // backpressure to the remote party based on our user's actual consumption rather than keep allocating memory.
        if (this._multiplexingStream.backpressureSupportEnabled && buffer) {
            this._multiplexingStream.localContentExamined(this, buffer.length);
        }
    }

    public onContentProcessed(bytesProcessed: number) {
        if (bytesProcessed < 0) {
            throw new Error("A non-negative number is required.");
        }

        if (bytesProcessed > this.remoteWindowFilled) {
            throw new Error("More bytes processed than we thought were in the window.");
        }

        if (this.remoteWindowSize === undefined) {
            throw new Error("Unexpected content processed message given we don't know the remote window size.");
        }

        this.remoteWindowFilled -= bytesProcessed;
        if (this.remoteWindowFilled < this.remoteWindowSize) {
            this.remoteWindowHasCapacity.resolve();
        }
    }

    public async dispose(errorToSend? : Error) {
        if (!this.isDisposed) {
            super.dispose();
            
            // If the caller passed in an error then send that error to the remote
            if (errorToSend) {
                await this._multiplexingStream.onChannelWritingError(this, errorToSend.message);
            }

            this._acceptance.reject(new CancellationToken.CancellationError("disposed"));

            // For the pipes, we Complete *our* ends, and leave the user's ends alone.
            // The completion will propagate when it's ready to. No need to destroy the duplex
            // as the frame containing the error message has already been sent. 
            this._duplex.end();
            this._duplex.push(null);

            // If we are sending an error to the remote side or received an error from the remote,
            // relay that information to the clients. 
            if (errorToSend ?? this.remoteError) {
                this._completion.reject(errorToSend ?? this.remoteError);
            } else {
                this._completion.resolve();
            }
            
            await this._multiplexingStream.onChannelDisposed(this);
        }
    }

    private onTransmittingBytes(transmittedBytes: number): void {
        if (this._multiplexingStream.backpressureSupportEnabled) {
            if (transmittedBytes < 0) {
                throw new Error("Negative byte count transmitted.");
            }

            this.remoteWindowFilled += transmittedBytes;
            if (this.remoteWindowFilled === this.remoteWindowSize) {
                // Suspend writing.
                this.remoteWindowHasCapacity = new Deferred<void>();
            }
        }
    }
}
