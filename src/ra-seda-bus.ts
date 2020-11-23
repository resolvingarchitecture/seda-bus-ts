
// Staged Event-Driven Architectural Bus

export class SEDABus {

    constructor(){}

    public send(env: Envelope): boolean {

        return true;
    }

    public deadLetter(env: Envelope): boolean {

        return true;
    }

    private determineRoute(env: Envelope): Route {
        let route: Route = null;

        return route;
    }


}
