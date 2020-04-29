"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const chalk_1 = require("chalk");
const DomainInfo = require("./DomainInfo");
const DomainConfig = require("./DomainConfig");
const Globals_1 = require("./Globals");
const certStatuses = ["PENDING_VALIDATION", "ISSUED", "INACTIVE"];
class ServerlessCustomDomain {
    constructor(serverless, options) {
        // Domain Manager specific properties
        this.domains = [];
        this.serverless = serverless;
        Globals_1.default.serverless = serverless;
        this.options = options;
        Globals_1.default.options = options;
        this.commands = {
            create_domain: {
                lifecycleEvents: [
                    "create",
                    "initialize",
                ],
                usage: "Creates a domain using the domain name defined in the serverless file",
            },
            delete_domain: {
                lifecycleEvents: [
                    "delete",
                    "initialize",
                ],
                usage: "Deletes a domain using the domain name defined in the serverless file",
            },
        };
        this.hooks = {
            "after:deploy:deploy": this.hookWrapper.bind(this, this.setupBasePathMappings),
            "after:info:info": this.hookWrapper.bind(this, this.domainSummaries),
            "before:deploy:deploy": this.hookWrapper.bind(this, this.updateCloudFormationOutputs),
            "before:remove:remove": this.hookWrapper.bind(this, this.removeBasePathMappings),
            "create_domain:create": this.hookWrapper.bind(this, this.createDomains),
            "delete_domain:delete": this.hookWrapper.bind(this, this.deleteDomains),
        };
    }
    /**
     * Wrapper for lifecycle function, initializes variables and checks if enabled.
     * @param lifecycleFunc lifecycle function that actually does desired action
     */
    hookWrapper(lifecycleFunc) {
        return __awaiter(this, void 0, void 0, function* () {
            this.initializeVariables();
            return yield lifecycleFunc.call(this);
        });
    }
    /**
     * Lifecycle function to create a domain
     * Wraps creating a domain and resource record set
     */
    createDomains() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.getDomainInfo();
            yield Promise.all(this.domains.map((domain) => __awaiter(this, void 0, void 0, function* () {
                try {
                    if (!domain.domainInfo) {
                        domain.certificateArn = yield this.getCertArn(domain);
                        yield this.createCustomDomain(domain);
                        yield this.changeResourceRecordSet("UPSERT", domain);
                        this.serverless.cli.log(`Custom domain ${domain.givenDomainName} was created.
                        New domains may take up to 40 minutes to be initialized.`);
                    }
                    else {
                        this.serverless.cli.log(`Custom domain ${domain.givenDomainName} already exists.`);
                    }
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    throw new Error(`Error: Unable to craete domain ${domain.givenDomainName}`);
                }
            })));
        });
    }
    /**
     * Lifecycle function to delete a domain
     * Wraps deleting a domain and resource record set
     */
    deleteDomains() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.getDomainInfo();
            yield Promise.all(this.domains.map((domain) => __awaiter(this, void 0, void 0, function* () {
                try {
                    if (domain.domainInfo) {
                        yield this.deleteCustomDomain(domain);
                        yield this.changeResourceRecordSet("DELETE", domain);
                        domain.domainInfo = undefined;
                        this.serverless.cli.log(`Custom domain ${domain.givenDomainName} was deleted.`);
                    }
                    else {
                        this.serverless.cli.log(`Custom domain ${domain.givenDomainName} does not exists.`);
                    }
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    throw new Error(`Error: Unable to delete domain ${domain.givenDomainName}`);
                }
            })));
        });
    }
    /**
     * Lifecycle function to add domain info to the CloudFormation stack's Outputs
     */
    updateCloudFormationOutputs() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.getDomainInfo();
            yield Promise.all(this.domains.map((domain) => __awaiter(this, void 0, void 0, function* () {
                this.addOutputs(domain);
            })));
        });
    }
    /**
     * Lifecycle function to create basepath mapping
     * Wraps creation of basepath mapping and adds domain name info as output to cloudformation stack
     */
    setupBasePathMappings() {
        return __awaiter(this, void 0, void 0, function* () {
            yield Promise.all(this.domains.map((domain) => __awaiter(this, void 0, void 0, function* () {
                try {
                    domain.apiId = yield this.getApiId(domain);
                    domain.apiMapping = yield this.getBasePathMapping(domain);
                    if (!domain.apiMapping) {
                        yield this.createBasePathMapping(domain);
                    }
                    else {
                        yield this.updateBasePathMapping(domain);
                    }
                    yield this.getDomainInfo();
                    // this.addOutputs(domain);
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    throw new Error(`Error: Unable to setup base domain mappings for ${domain.givenDomainName}`);
                }
            }))).then(() => {
                // Print summary upon completion
                this.domains.forEach((domain) => {
                    this.printDomainSummary(domain);
                });
            });
        });
    }
    /**
     * Lifecycle function to delete basepath mapping
     * Wraps deletion of basepath mapping
     */
    removeBasePathMappings() {
        return __awaiter(this, void 0, void 0, function* () {
            yield Promise.all(this.domains.map((domain) => __awaiter(this, void 0, void 0, function* () {
                try {
                    domain.apiId = yield this.getApiId(domain);
                    // Unable to find the correspond API, manuall clean up will be required
                    if (!domain.apiId) {
                        this.serverless.cli.log(`Unable to find corresponding API for ${domain.givenDomainName},
                        API Mappings may need to be manually removed.`, "Serverless Domain Manager");
                    }
                    else {
                        domain.apiMapping = yield this.getBasePathMapping(domain);
                        yield this.deleteBasePathMapping(domain);
                    }
                }
                catch (err) {
                    if (err.message.indexOf("Failed to find CloudFormation") > -1) {
                        this.serverless.cli.log(`Unable to find Cloudformation Stack for ${domain.givenDomainName},
                        API Mappings may need to be manually removed.`, "Serverless Domain Manager");
                    }
                    else {
                        this.logIfDebug(err, domain.givenDomainName);
                        throw new Error(`Error: Unable to remove base bath mappings for domain ${domain.givenDomainName}`);
                    }
                }
            })));
        });
    }
    /**
     * Lifecycle function to print domain summary
     * Wraps printing of all domain manager related info
     */
    domainSummaries() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.getDomainInfo();
            this.domains.forEach((domain) => {
                if (domain.domainInfo) {
                    this.printDomainSummary(domain);
                }
                else {
                    this.serverless.cli.log(`Unable to print Serverless Domain Manager Summary for ${domain.givenDomainName}`);
                }
            });
        });
    }
    /**
     * Goes through custom domain property and initializes local variables and cloudformation template
     */
    initializeVariables() {
        // Make sure customDomain configuration exists, stop if not
        if (typeof this.serverless.service.custom === "undefined"
            || typeof this.serverless.service.custom.customDomain === "undefined") {
            throw new Error("serverless-domain-manager: Plugin configuration is missing.");
        }
        const credentials = this.serverless.providers.aws.getCredentials();
        credentials.region = this.serverless.providers.aws.getRegion();
        this.serverless.providers.aws.sdk.config.update({ maxRetries: 20 });
        this.apigateway = new this.serverless.providers.aws.sdk.APIGateway(credentials);
        this.apigatewayV2 = new this.serverless.providers.aws.sdk.ApiGatewayV2(credentials);
        this.route53 = new this.serverless.providers.aws.sdk.Route53(credentials);
        this.cloudformation = new this.serverless.providers.aws.sdk.CloudFormation(credentials);
        // Loop over the domain configurations and popluates the domains array with DomainConfigs
        this.domains = [];
        // If the key of the item in config is an api type it is using per api type domain structure
        if (Globals_1.default.apiTypes[Object.keys(this.serverless.service.custom.customDomain)[0]]) {
            for (const configApiType in this.serverless.service.custom.customDomain) {
                if (Globals_1.default.apiTypes[configApiType]) { // If statement check to follow tslint
                    this.serverless.service.custom.customDomain[configApiType].apiType = configApiType;
                    this.domains.push(new DomainConfig(this.serverless.service.custom.customDomain[configApiType]));
                }
                else {
                    throw Error(`Error: Invalud API Type, ${configApiType}`);
                }
            }
        }
        else { // Default to single domain config
            this.domains.push(new DomainConfig(this.serverless.service.custom.customDomain));
        }
        // Filter inactive domains
        this.domains = this.domains.filter((domain) => domain.enabled);
        // Set ACM Region on the domain configs
        for (const dc of this.domains) {
            this.acmRegion = dc.endpointType === Globals_1.default.endpointTypes.regional ?
                this.serverless.providers.aws.getRegion() : "us-east-1";
            const acmCredentials = Object.assign({}, credentials, { region: this.acmRegion });
            this.acm = new this.serverless.providers.aws.sdk.ACM(acmCredentials);
        }
        // Validate the domain configuraitons
        this.validateDomainConfigs();
    }
    /**
     * Validates domain configs to make sure they are valid, ie HTTP api cannot be used with EDGE domain
     */
    validateDomainConfigs() {
        this.domains.forEach((domain) => {
            // Show warning if allowPathMatching is set to true
            if (domain.allowPathMatching) {
                this.serverless.cli.log(`WARNING: "allowPathMatching" is set for ${domain.givenDomainName}.
                    This should only be used when migrating a path to a different API type. e.g. REST to HTTP.`);
            }
            if (domain.apiType === Globals_1.default.apiTypes.rest) {
                // Currently no validation for REST API types
            }
            else if (domain.apiType === Globals_1.default.apiTypes.http) { // Validation for http apis
                // HTTP Apis do not support edge domains
                if (domain.endpointType === Globals_1.default.endpointTypes.edge) {
                    throw Error(`Error: 'edge' endpointType is not compatible with HTTP APIs`);
                }
            }
            else if (domain.apiType === Globals_1.default.apiTypes.websocket) { // Validation for WebSocket apis
                // Websocket Apis do not support edge domains
                if (domain.endpointType === Globals_1.default.endpointTypes.edge) {
                    throw Error(`Error: 'edge' endpointType is not compatible with WebSocket APIs`);
                }
            }
        });
    }
    /**
     * Gets Certificate ARN that most closely matches domain name OR given Cert ARN if provided
     */
    getCertArn(domain) {
        return __awaiter(this, void 0, void 0, function* () {
            if (domain.certificateArn) {
                this.serverless.cli.log(`Selected specific certificateArn ${domain.certificateArn}`);
                return domain.certificateArn;
            }
            let certificateArn; // The arn of the choosen certificate
            let certificateName = domain.certificateName; // The certificate name
            try {
                let certificates = [];
                let nextToken;
                do {
                    const certData = yield this.acm.listCertificates({ CertificateStatuses: certStatuses, NextToken: nextToken }).promise();
                    certificates = certificates.concat(certData.CertificateSummaryList);
                    nextToken = certData.NextToken;
                } while (nextToken);
                // The more specific name will be the longest
                let nameLength = 0;
                // Checks if a certificate name is given
                if (certificateName != null) {
                    const foundCertificate = certificates
                        .find((certificate) => (certificate.DomainName === certificateName));
                    if (foundCertificate != null) {
                        certificateArn = foundCertificate.CertificateArn;
                    }
                }
                else {
                    certificateName = domain.givenDomainName;
                    certificates.forEach((certificate) => {
                        let certificateListName = certificate.DomainName;
                        // Looks for wild card and takes it out when checking
                        if (certificateListName[0] === "*") {
                            certificateListName = certificateListName.substr(1);
                        }
                        // Looks to see if the name in the list is within the given domain
                        // Also checks if the name is more specific than previous ones
                        if (certificateName.includes(certificateListName)
                            && certificateListName.length > nameLength) {
                            nameLength = certificateListName.length;
                            certificateArn = certificate.CertificateArn;
                        }
                    });
                }
            }
            catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw Error(`Error: Could not list certificates in Certificate Manager.\n${err}`);
            }
            if (certificateArn == null) {
                throw Error(`Error: Could not find the certificate ${certificateName}.`);
            }
            return certificateArn;
        });
    }
    /**
     * Populates the DomainInfo object on the Domains if custom domain in aws exists
     */
    getDomainInfo() {
        return __awaiter(this, void 0, void 0, function* () {
            yield Promise.all(this.domains.map((domain) => __awaiter(this, void 0, void 0, function* () {
                try {
                    const domainInfo = yield this.apigatewayV2.getDomainName({
                        DomainName: domain.givenDomainName,
                    }).promise();
                    domain.domainInfo = new DomainInfo(domainInfo);
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    if (err.code !== "NotFoundException") {
                        throw new Error(`Error: Unable to fetch information about ${domain.givenDomainName}`);
                    }
                }
            })));
        });
    }
    /**
     * Creates Custom Domain Name through API Gateway
     * @param certificateArn: Certificate ARN to use for custom domain
     */
    createCustomDomain(domain) {
        return __awaiter(this, void 0, void 0, function* () {
            let createdDomain = {};
            // For EDGE domain name, create with APIGateway (v1)
            if (domain.endpointType === Globals_1.default.endpointTypes.edge) {
                // Set up parameters
                const params = {
                    certificateArn: domain.certificateArn,
                    domainName: domain.givenDomainName,
                    endpointConfiguration: {
                        types: [domain.endpointType],
                    },
                    securityPolicy: domain.securityPolicy,
                };
                // Make API call to create domain
                try {
                    // If creating REST api use v1 of api gateway, else use v2 for HTTP and Websocket
                    createdDomain = yield this.apigateway.createDomainName(params).promise();
                    domain.domainInfo = new DomainInfo(createdDomain);
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    throw new Error(`Error: Failed to create custom domain ${domain.givenDomainName}\n`);
                }
            }
            else { // For Regional domain name create with ApiGatewayV2
                const params = {
                    DomainName: domain.givenDomainName,
                    DomainNameConfigurations: [{
                            CertificateArn: domain.certificateArn,
                            EndpointType: domain.endpointType,
                            SecurityPolicy: domain.securityPolicy,
                        }],
                };
                // Make API call to create domain
                try {
                    // If creating REST api use v1 of api gateway, else use v2 for HTTP and Websocket
                    createdDomain = yield this.apigatewayV2.createDomainName(params).promise();
                    domain.domainInfo = new DomainInfo(createdDomain);
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    throw new Error(`Error: Failed to create custom domain ${domain.givenDomainName}\n`);
                }
            }
        });
    }
    /**
     * Delete Custom Domain Name through API Gateway
     */
    deleteCustomDomain(domain) {
        return __awaiter(this, void 0, void 0, function* () {
            // Make API call
            try {
                yield this.apigatewayV2.deleteDomainName({ DomainName: domain.givenDomainName }).promise();
            }
            catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw new Error(`Error: Failed to delete custom domain ${domain.givenDomainName}\n`);
            }
        });
    }
    /**
     * Change A Alias record through Route53 based on given action
     * @param action: String descriptor of change to be made. Valid actions are ['UPSERT', 'DELETE']
     * @param domain: DomainInfo object containing info about custom domain
     */
    changeResourceRecordSet(action, domain) {
        return __awaiter(this, void 0, void 0, function* () {
            if (action !== "UPSERT" && action !== "DELETE") {
                throw new Error(`Error: Invalid action "${action}" when changing Route53 Record.
                Action must be either UPSERT or DELETE.\n`);
            }
            const createRoute53Record = domain.createRoute53Record;
            if (createRoute53Record !== undefined && createRoute53Record === false) {
                this.serverless.cli.log(`Skipping ${action === "DELETE" ? "removal" : "creation"} of Route53 record.`);
                return;
            }
            // Set up parameters
            const route53HostedZoneId = yield this.getRoute53HostedZoneId(domain);
            const Changes = ["A", "AAAA"].map((Type) => ({
                Action: action,
                ResourceRecordSet: {
                    AliasTarget: {
                        DNSName: domain.domainInfo.domainName,
                        EvaluateTargetHealth: false,
                        HostedZoneId: domain.domainInfo.hostedZoneId,
                    },
                    Name: domain.givenDomainName,
                    Type,
                },
            }));
            const params = {
                ChangeBatch: {
                    Changes,
                    Comment: "Record created by serverless-domain-manager",
                },
                HostedZoneId: route53HostedZoneId,
            };
            // Make API call
            try {
                yield this.route53.changeResourceRecordSets(params).promise();
            }
            catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw new Error(`Error: Failed to ${action} A Alias for ${domain.givenDomainName}\n`);
            }
        });
    }
    /**
     * Gets Route53 HostedZoneId from user or from AWS
     */
    getRoute53HostedZoneId(domain) {
        return __awaiter(this, void 0, void 0, function* () {
            if (domain.hostedZoneId) {
                this.serverless.cli.log(`Selected specific hostedZoneId ${this.serverless.service.custom.customDomain.hostedZoneId}`);
                return domain.hostedZoneId;
            }
            const filterZone = domain.hostedZonePrivate !== undefined;
            if (filterZone && domain.hostedZonePrivate) {
                this.serverless.cli.log("Filtering to only private zones.");
            }
            else if (filterZone && !domain.hostedZonePrivate) {
                this.serverless.cli.log("Filtering to only public zones.");
            }
            let hostedZoneData;
            const givenDomainNameReverse = domain.givenDomainName.split(".").reverse();
            try {
                hostedZoneData = yield this.route53.listHostedZones({}).promise();
                const targetHostedZone = hostedZoneData.HostedZones
                    .filter((hostedZone) => {
                    let hostedZoneName;
                    if (hostedZone.Name.endsWith(".")) {
                        hostedZoneName = hostedZone.Name.slice(0, -1);
                    }
                    else {
                        hostedZoneName = hostedZone.Name;
                    }
                    if (!filterZone || domain.hostedZonePrivate === hostedZone.Config.PrivateZone) {
                        const hostedZoneNameReverse = hostedZoneName.split(".").reverse();
                        if (givenDomainNameReverse.length === 1
                            || (givenDomainNameReverse.length >= hostedZoneNameReverse.length)) {
                            for (let i = 0; i < hostedZoneNameReverse.length; i += 1) {
                                if (givenDomainNameReverse[i] !== hostedZoneNameReverse[i]) {
                                    return false;
                                }
                            }
                            return true;
                        }
                    }
                    return false;
                })
                    .sort((zone1, zone2) => zone2.Name.length - zone1.Name.length)
                    .shift();
                if (targetHostedZone) {
                    const hostedZoneId = targetHostedZone.Id;
                    // Extracts the hostzone Id
                    const startPos = hostedZoneId.indexOf("e/") + 2;
                    const endPos = hostedZoneId.length;
                    return hostedZoneId.substring(startPos, endPos);
                }
            }
            catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw new Error(`Error: Unable to list hosted zones in Route53.\n${err}`);
            }
            throw new Error(`Error: Could not find hosted zone "${domain.givenDomainName}"`);
        });
    }
    getBasePathMapping(domain) {
        return __awaiter(this, void 0, void 0, function* () {
            const params = {
                DomainName: domain.givenDomainName,
            };
            try {
                const mappings = yield this.apigatewayV2.getApiMappings(params).promise();
                if (mappings.Items.length === 0) {
                    return;
                }
                else {
                    for (const mapping of mappings.Items) {
                        if (mapping.ApiId === domain.apiId
                            || (mapping.ApiMappingKey === domain.basePath && domain.allowPathMatching)) {
                            return mapping;
                        }
                    }
                }
            }
            catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw new Error(`Error: Unable to get API Mappings for ${domain.givenDomainName}`);
            }
        });
    }
    /**
     * Creates basepath mapping
     */
    createBasePathMapping(domain) {
        return __awaiter(this, void 0, void 0, function* () {
            // Use APIGateway (v1) for EDGE domains
            if (domain.endpointType === Globals_1.default.endpointTypes.edge) {
                const params = {
                    basePath: domain.basePath,
                    domainName: domain.givenDomainName,
                    restApiId: domain.apiId,
                    stage: domain.stage,
                };
                // Make API call
                try {
                    yield this.apigateway.createBasePathMapping(params).promise();
                    this.serverless.cli.log(`Created API mapping '${domain.basePath}' for ${domain.givenDomainName}`);
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    throw new Error(`Error: ${domain.givenDomainName}: Unable to create basepath mapping.\n`);
                }
            }
            else { // Use ApiGatewayV2 for Regional domains
                const params = {
                    ApiId: domain.apiId,
                    ApiMappingKey: domain.basePath,
                    DomainName: domain.givenDomainName,
                    Stage: domain.apiType === Globals_1.default.apiTypes.http ? "$default" : domain.stage,
                };
                // Make API call
                try {
                    yield this.apigatewayV2.createApiMapping(params).promise();
                    this.serverless.cli.log(`Created API mapping '${domain.basePath}' for ${domain.givenDomainName}`);
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    throw new Error(`Error: ${domain.givenDomainName}: Unable to create basepath mapping.\n`);
                }
            }
        });
    }
    /**
     * Updates basepath mapping
     */
    updateBasePathMapping(domain) {
        return __awaiter(this, void 0, void 0, function* () {
            // Use APIGateway (v1) for EDGE domains
            if (domain.endpointType === Globals_1.default.endpointTypes.edge) {
                const params = {
                    basePath: domain.apiMapping.ApiMappingKey,
                    domainName: domain.givenDomainName,
                    patchOperations: [
                        {
                            op: "replace",
                            path: "/basePath",
                            value: domain.basePath,
                        },
                    ],
                };
                // Make API call
                try {
                    yield this.apigateway.updateBasePathMapping(params).promise();
                    this.serverless.cli.log(`Updated API mapping from '${domain.apiMapping.ApiMappingKey}'
                     to '${domain.basePath}' for ${domain.givenDomainName}`);
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    throw new Error(`Error: ${domain.givenDomainName}: Unable to update basepath mapping.\n`);
                }
            }
            else { // Use ApiGatewayV2 for Regional domains
                const params = {
                    ApiId: domain.apiId,
                    ApiMappingId: domain.apiMapping.ApiMappingId,
                    ApiMappingKey: domain.basePath,
                    DomainName: domain.givenDomainName,
                    Stage: domain.apiType === Globals_1.default.apiTypes.http ? "$default" : domain.stage,
                };
                // Make API call
                try {
                    yield this.apigatewayV2.updateApiMapping(params).promise();
                    this.serverless.cli.log(`Updated API mapping to '${domain.basePath}' for ${domain.givenDomainName}`);
                }
                catch (err) {
                    this.logIfDebug(err, domain.givenDomainName);
                    throw new Error(`Error: ${domain.givenDomainName}: Unable to update basepath mapping.\n`);
                }
            }
        });
    }
    /**
     * Gets rest API id from CloudFormation stack
     */
    getApiId(domain) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.serverless.service.provider.apiGateway && this.serverless.service.provider.apiGateway.restApiId) {
                this.serverless.cli.log(`Mapping custom domain to existing API
                ${this.serverless.service.provider.apiGateway.restApiId}.`);
                return this.serverless.service.provider.apiGateway.restApiId;
            }
            const stackName = this.serverless.service.provider.stackName ||
                `${this.serverless.service.service}-${domain.stage}`;
            let LogicalResourceId = "ApiGatewayRestApi";
            if (domain.apiType === Globals_1.default.apiTypes.http) {
                LogicalResourceId = "HttpApi";
            }
            else if (domain.apiType === Globals_1.default.apiTypes.websocket) {
                LogicalResourceId = "WebsocketsApi";
            }
            const params = {
                LogicalResourceId,
                StackName: stackName,
            };
            let response;
            try {
                response = yield this.cloudformation.describeStackResource(params).promise();
            }
            catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw new Error(`Error: Failed to find CloudFormation resources for ${domain.givenDomainName}\n`);
            }
            const apiId = response.StackResourceDetail.PhysicalResourceId;
            if (!apiId) {
                throw new Error(`Error: No ApiId associated with CloudFormation stack ${stackName}`);
            }
            return apiId;
        });
    }
    /**
     * Deletes basepath mapping
     */
    deleteBasePathMapping(domain) {
        return __awaiter(this, void 0, void 0, function* () {
            const params = {
                ApiMappingId: domain.apiMapping.ApiMappingId,
                DomainName: domain.givenDomainName,
            };
            // Make API call
            try {
                yield this.apigatewayV2.deleteApiMapping(params).promise();
                this.serverless.cli.log("Removed basepath mapping.");
            }
            catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                this.serverless.cli.log(`Unable to remove basepath mapping for ${domain.givenDomainName}`);
            }
        });
    }
    /**
     *  Adds the domain name and distribution domain name to the CloudFormation outputs
     */
    addOutputs(domain) {
        const service = this.serverless.service;
        if (!service.provider.compiledCloudFormationTemplate.Outputs) {
            service.provider.compiledCloudFormationTemplate.Outputs = {};
        }
        // Defaults for REST and backwards compatibility
        let distributionDomainNameOutputKey = "DistributionDomainName";
        let domainNameOutputKey = "DomainName";
        let hostedZoneIdOutputKey = "HostedZoneId";
        if (domain.apiType === Globals_1.default.apiTypes.http) {
            distributionDomainNameOutputKey += "Http";
            domainNameOutputKey += "Http";
            hostedZoneIdOutputKey += "Http";
        }
        else if (domain.apiType === Globals_1.default.apiTypes.websocket) {
            distributionDomainNameOutputKey += "Websocket";
            domainNameOutputKey += "Websocket";
            hostedZoneIdOutputKey += "Websocket";
        }
        service.provider.compiledCloudFormationTemplate.Outputs[distributionDomainNameOutputKey] = {
            Value: domain.domainInfo.domainName,
        };
        service.provider.compiledCloudFormationTemplate.Outputs[domainNameOutputKey] = {
            Value: domain.givenDomainName,
        };
        if (domain.domainInfo.hostedZoneId) {
            service.provider.compiledCloudFormationTemplate.Outputs[hostedZoneIdOutputKey] = {
                Value: domain.domainInfo.hostedZoneId,
            };
        }
    }
    /**
     * Logs message if SLS_DEBUG is set
     * @param message message to be printed
     */
    logIfDebug(message, domain) {
        if (process.env.SLS_DEBUG) {
            this.serverless.cli.log(`Error: ${domain ? domain + ": " : ""} ${message}`, "Serverless Domain Manager");
        }
    }
    /**
     * Prints out a summary of all domain manager related info
     */
    printDomainSummary(domain) {
        this.serverless.cli.consoleLog(chalk_1.default.yellow.underline("\nServerless Domain Manager Summary"));
        this.serverless.cli.consoleLog(chalk_1.default.yellow("Distribution Domain Name"));
        this.serverless.cli.consoleLog(`  Domain Name: ${domain.givenDomainName}`);
        this.serverless.cli.consoleLog(`  Target Domain: ${domain.domainInfo.domainName}`);
        this.serverless.cli.consoleLog(`  Hosted Zone Id: ${domain.domainInfo.hostedZoneId}`);
    }
}
module.exports = ServerlessCustomDomain;
