import * as builder from 'botbuilder';
import { Express } from 'express';
import { defaultProvider } from './provider';

// Options for state of a conversation
// Customer talking to bot, waiting for next available agent or talking to an agent
export enum ConversationState {
    Bot,
    Waiting,
    Agent,
    Watch,
    Resolve
}

// What an entry in the customer transcript will have
export interface TranscriptLine {
    timestamp: any,
    from: any,
    text: string,
    toResolve?: builder.Message,
    deferred?: Deferred   
}

export interface Deferred {
    resolve: Function,
    reject: Function
}

// What is stored in a conversation. Agent only included if customer is talking to an agent
export interface Conversation {
    customer: builder.IAddress,
    agent?: builder.IAddress,
    state: ConversationState,
    transcript: TranscriptLine[],
    customerConversationId: string
};

// Used in getConversation in provider. Gives context to the search and changes behavior
export interface By {
    bestChoice?: true,
    agentConversationId?: string,
    customerConversationId?: string,
    customerName?: string
}

export interface Provider {
    init();

    // Supervised
    await: (customerConversationId: string, resolve: Function, reject: Function, toResolve?: builder.Message) => void;
    changeStateToResolve: (by: By) => boolean;


    // Update
    addToTranscript: (by: By, text: string) => boolean;
    connectCustomerToAgent: (by: By, agentAddress: builder.IAddress, nextState?: ConversationState) => Conversation;
    connectCustomerToBot: (by: By) => boolean;
    queueCustomerForAgent: (by: By) => boolean;

    // Get
    getConversation: (by: By, customerAddress?: builder.IAddress) => Conversation;
    currentConversations: () => Conversation[];
}

export class Handoff {
    // if customizing, pass in your own check for isAgent and your own versions of methods in defaultProvider
    constructor(
        private bot: builder.UniversalBot,
        public isAgent: (session: builder.Session) => boolean,
        private provider: Provider = defaultProvider
    ) {
        this.provider.init();
    }

    public routingMiddleware() {
        return {
            botbuilder: (session: builder.Session, next: Function) => {
                // Pass incoming messages to routing method
                if (session.message.type === 'message') {
                    this.routeMessage(session, next);
                }
            },
            send: (event: builder.IEvent, next: Function) => {
                // Messages sent from the bot do not need to be routed
                const message: builder.IMessage = event as builder.IMessage;
                const customerConversation: Conversation = this.getConversation({ customerConversationId: event.address.conversation.id });
                // TODO is error checking for state watch with no agent necessary here?
                if (customerConversation.state === ConversationState.Watch) {
                    this.bot.send(new builder.Message().address(customerConversation.agent).text(message.text));
                }
                this.trancribeMessageFromBot(message, next);
            }
        }
    }

    private routeMessage(
        session: builder.Session,
        next: Function
    ) {
        if (this.isAgent(session)) {
            this.routeAgentMessage(session)
        } else {
            this.routeCustomerMessage(session, next);
        }
    }

    private routeAgentMessage(session: builder.Session) {
        const message: builder.IMessage = session.message;
        const conversation: Conversation = this.getConversation({ agentConversationId: message.address.conversation.id });

        // if the agent is not in conversation, no further routing is necessary
        if (!conversation)
            return;

        if (conversation.state === ConversationState.Watch)
            return;

        // send text that agent typed to the customer they are in conversation with
        this.bot.send(new builder.Message().address(conversation.customer).text(message.text));
    }

    private routeCustomerMessage(session: builder.Session, next: Function) {
        const message: builder.IMessage = session.message;
        // method will either return existing conversation or a newly created conversation if this is first time we've heard from customer
        const conversation: Conversation = this.getConversation({ customerConversationId: message.address.conversation.id }, message.address);
        this.addToTranscript({ customerConversationId: conversation.customer.conversation.id }, message.text);

        switch (conversation.state) {
            case ConversationState.Bot:
            case ConversationState.Resolve:
                return next();
            case ConversationState.Waiting:
                session.send("Connecting you to the next available agent.");
                return;
            case ConversationState.Watch:
                this.bot.send(new builder.Message().address(conversation.agent).text(message.text));
                return next();
            case ConversationState.Agent:
                if (!conversation.agent) {
                    session.send("No agent address present while customer in state Agent");
                    console.log("No agent address present while customer in state Agent");
                    return;
                }
                this.bot.send(new builder.Message().address(conversation.agent).text(message.text));
                return;
        }
    }

    // These methods are wrappers around provider which handles data
    private trancribeMessageFromBot(message: builder.IMessage, next: Function) {
        this.provider.addToTranscript({ customerConversationId: message.address.conversation.id }, message.text);
        next();
    }

    public getCustomerTranscript(by: By, session: builder.Session) {
        // TODO clean up this logic. Probably shouldn't all live here.
        const customerConversation: Conversation = this.getConversation(by);
        if (customerConversation) {
            customerConversation.transcript.forEach(transcriptLine =>
                session.send(transcriptLine.text));
        } else {
            session.send('No Transcript to show. Try entering a username or try again when connected to a customer');
        }
    }

    public connectCustomerToAgent = (by: By, agentAddress: builder.IAddress, nextState?: ConversationState) =>
        this.provider.connectCustomerToAgent(by, agentAddress, nextState);

    public connectCustomerToBot = (by: By) =>
        this.provider.connectCustomerToBot(by);

    public queueCustomerForAgent = (by: By) =>
        this.provider.queueCustomerForAgent(by);

    public addToTranscript = (by: By, text: string) =>
        this.provider.addToTranscript(by, text);

    public getConversation = (by: By, customerAddress?: builder.IAddress) =>
        this.provider.getConversation(by, customerAddress);

    public currentConversations = () =>
        this.provider.currentConversations();

    public await = (customerConversationId: string, resolve: Function, reject: Function, toResolve?: builder.Message) =>
        this.provider.await(customerConversationId, resolve, reject, toResolve);

    public changeStateToResolve = (by: By) =>
        this.provider.changeStateToResolve(by);
};
