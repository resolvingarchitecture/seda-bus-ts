// Staged Event-Driven Architectural Bus
export class SEDABus {

}

export class Envelope {
    id: number;
    dynamicRoutingSlip: DynamicRoutingSlip;
    route: Route;
    did: DID;
    url: string;
    charset: string;
    action: string;
    sensitivity: number;
    serviceLevel: number;
    minDelay: number;
    maxDelay: number;
    message: Message;
}

export class DynamicRoutingSlip {
    routes: Array<Route>;
    constructor() {
        this.routes = new Array<Route>();
    }
}

export class Route {
    type: string;
    service: string;
    operation: string;
}

export class DID {
    username: string;
    passphrase: string;
    passphrase2: string;
    description: string;
    status: string;
    verified: boolean;
    authenticated: boolean;
    publicKey: string;
}

export interface Message {

}

export class BaseMessage implements Message {
    errorMessages: Array<string>;
    constructor() {
        this.errorMessages = new Array<string>();
    }
}

export class DocumentMessage extends BaseMessage {
    type: 'ra.common.messaging.DocumentMessage';
    data: Array<Map<string,object>>;
    constructor() {
        super();
        this.data = new Array(new Map<string,object>());
    }
}

export class EventMessage extends BaseMessage {
    type: 'ra.common.messaging.EventMessage';
    constructor() {
        super();
    }
}
