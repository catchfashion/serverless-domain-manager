"use strict";

import chalk from "chalk";
import DomainInfo = require("./DomainInfo");
import DomainConfig = require("./DomainConfig");
import Globals from "./Globals";

import { ServerlessInstance, ServerlessOptions } from "./types";

const certStatuses = ["PENDING_VALIDATION", "ISSUED", "INACTIVE"];

class ServerlessCustomDomain {

    // AWS SDK resources
    public apigateway: any;
    public apigatewayV2: any;
    public route53: any;
    public acm: any;
    public acmRegion: string;
    public cloudformation: any;

    // Serverless specific properties
    public serverless: ServerlessInstance;
    public options: ServerlessOptions;
    public commands: object;
    public hooks: object;

    // Domain Manager specific properties
    public domains: DomainConfig[] = [];

    constructor(serverless: ServerlessInstance, options: ServerlessOptions) {
        this.serverless = serverless;
        Globals.serverless = serverless;

        this.options = options;
        Globals.options = options;

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
            // "after:deploy:deploy": this.hookWrapper.bind(this, this.setupBasePathMapping),
            // "after:info:info": this.hookWrapper.bind(this, this.domainSummary),
            // "before:remove:remove": this.hookWrapper.bind(this, this.removeBasePathMapping),
            "create_domain:create": this.hookWrapper.bind(this, this.createDomains),
            "delete_domain:delete": this.hookWrapper.bind(this, this.deleteDomains),
        };
    }

    /**
     * Wrapper for lifecycle function, initializes variables and checks if enabled.
     * @param lifecycleFunc lifecycle function that actually does desired action
     */
    public async hookWrapper(lifecycleFunc: any) {

        // Make sure customDomain configuration exists, stop if not
        if (typeof this.serverless.service.custom === "undefined"
            || typeof this.serverless.service.custom.customDomain === "undefined") {
            throw new Error("serverless-domain-manager: Plugin configuration is missing.");
        }

        this.initializeVariables();

        return await lifecycleFunc.call(this);
    }

    /**
     * Lifecycle function to create a domain
     * Wraps creating a domain and resource record set
     */
    public async createDomains(): Promise<void> {

        await this.getDomainInfo();

        await Promise.all(this.domains.map(async (domain) => {
            try {
                if (!domain.domainInfo) {

                    domain.certificateArn = await this.getCertArn(domain);

                    await this.createCustomDomain(domain);

                    await this.changeResourceRecordSet("UPSERT", domain);

                    this.serverless.cli.log(
                        `Custom domain ${domain.givenDomainName} was created. New domains may
                         take up to 40 minutes to be initialized.`,
                    );
                } else {
                    this.serverless.cli.log(`Custom domain ${domain.givenDomainName} already exists.`);
                }
            } catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw new Error(`Error: Unable to craete domain ${domain.givenDomainName}`);
            }
        }));
    }

    /**
     * Lifecycle function to delete a domain
     * Wraps deleting a domain and resource record set
     */
    public async deleteDomains(): Promise<void> {

        await this.getDomainInfo();

        await Promise.all(this.domains.map(async (domain) => {
            try {
                if (domain.domainInfo) {
                    await this.deleteCustomDomain(domain);
                    await this.changeResourceRecordSet("DELETE", domain);
                    this.serverless.cli.log(`Custom domain ${domain.givenDomainName} was deleted.`);
                } else {
                    this.serverless.cli.log(`Custom domain ${domain.givenDomainName} does not exists.`);
                }
            } catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw new Error(`Error: Unable to delete domain ${domain.givenDomainName}`);
            }
        }));
    }

    /**
     * Lifecycle function to create basepath mapping
     * Wraps creation of basepath mapping and adds domain name info as output to cloudformation stack
     */
    // public async setupBasePathMapping(): Promise<void> {
    //     // check if basepathmapping exists
    //     const apiId = await this.getApiId();
    //     const currentBasePath = await this.getBasePathMapping(apiId);

    //     // if basepath that matches apiId exists, update; else, create
    //     if (!currentBasePath) {
    //         await this.createBasePathMapping(apiId);
    //     } else {
    //         await this.updateBasePathMapping(currentBasePath);
    //     }
    //     const domainInfo = await this.getDomainInfo();
    //     this.addOutputs(domainInfo);
    //     await this.printDomainSummary(domainInfo);
    // }

    /**
     * Lifecycle function to delete basepath mapping
     * Wraps deletion of basepath mapping
     */
    // public async removeBasePathMapping(): Promise<void> {
    //     await this.deleteBasePathMapping();
    // }

    /**
     * Lifecycle function to print domain summary
     * Wraps printing of all domain manager related info
     */
    // public async domainSummary(): Promise<void> {
    //     const domainInfo = await this.getDomainInfo();
    //     if (domainInfo) {
    //         this.printDomainSummary(domainInfo);
    //     } else {
    //         this.serverless.cli.log("Unable to print Serverless Domain Manager Summary");
    //     }
    // }

    /**
     * Goes through custom domain property and initializes local variables and cloudformation template
     */
    public initializeVariables(): void {

        const credentials = this.serverless.providers.aws.getCredentials();
        credentials.region = this.serverless.providers.aws.getRegion();

        this.serverless.providers.aws.sdk.config.update({ maxRetries: 20 });
        this.apigateway = new this.serverless.providers.aws.sdk.APIGateway(credentials);
        this.apigatewayV2 = new this.serverless.providers.aws.sdk.ApiGatewayV2(credentials);
        this.route53 = new this.serverless.providers.aws.sdk.Route53(credentials);
        this.cloudformation = new this.serverless.providers.aws.sdk.CloudFormation(credentials);

        // Loop over the domain configurations and popluates the domains array with DomainConfigs
        for (const [key] of Object.entries(this.serverless.service.custom.customDomain)) {

            let dc: DomainConfig;

            // Handle defined API types where key is the api type
            if (key.toLowerCase() in Globals.apiTypes) {
                dc = new DomainConfig(this.serverless.service.custom.customDomain[key], key);

            } else { // legacy/single domain config
                dc = new DomainConfig(this.serverless.service.custom.customDomain,
                    this.serverless.service.custom.customDomain.apiType);
            }

            this.acmRegion = dc.endpointType === Globals.endpointTypes.regional ?
                this.serverless.providers.aws.getRegion() : "us-east-1";
            const acmCredentials = Object.assign({}, credentials, { region: this.acmRegion });
            this.acm = new this.serverless.providers.aws.sdk.ACM(acmCredentials);

            this.domains.push(dc);
        }
    }

    /**
     * Gets Certificate ARN that most closely matches domain name OR given Cert ARN if provided
     */
    public async getCertArn(domain: DomainConfig): Promise<string> {
        if (domain.certificateArn) {
            this.serverless.cli.log(`Selected specific certificateArn ${domain.certificateArn}`);
            return domain.certificateArn;
        }

        let certificateArn; // The arn of the choosen certificate
        let certificateName = domain.certificateName; // The certificate name
        let certData;
        try {
            certData = await this.acm.listCertificates(
                { CertificateStatuses: certStatuses }).promise();
            // The more specific name will be the longest
            let nameLength = 0;
            const certificates = certData.CertificateSummaryList;

            // Checks if a certificate name is given
            if (certificateName != null) {
                const foundCertificate = certificates
                    .find((certificate) => (certificate.DomainName === certificateName));
                if (foundCertificate != null) {
                    certificateArn = foundCertificate.CertificateArn;
                }
            } else {
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
        } catch (err) {
            this.logIfDebug(err, domain.givenDomainName);
            throw Error(`Error: Could not list certificates in Certificate Manager.\n${err}`);
        }
        if (certificateArn == null) {
            throw Error(`Error: Could not find the certificate ${certificateName}.`);
        }
        return certificateArn;
    }

    /**
     * Populates the DomainInfo object on the Domains if custom domain in aws exists
     */
    public async getDomainInfo(): Promise<void> {
        await Promise.all(this.domains.map(async (domain) => {
            try {
                const domainInfo = await this.apigateway.getDomainName({
                    domainName: domain.givenDomainName,
                }).promise();

                domain.domainInfo = new DomainInfo(domainInfo);
            } catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                if (err.code !== "NotFoundException") {
                    throw new Error(`Error: Unable to fetch information about ${domain.givenDomainName}`);
                }
            }
        }));
    }

    /**
     * Creates Custom Domain Name through API Gateway
     * @param certificateArn: Certificate ARN to use for custom domain
     */
    public async createCustomDomain(domain: DomainConfig): Promise<void> {

        let createdDomain = {};

        // Gateway API is completely different for v1 and v2 so seperating into two blocks
        if (domain.apiType === "REST") {
            // Set up parameters
            const params = {
                certificateArn: domain.certificateArn,
                domainName: domain.givenDomainName,
                endpointConfiguration: {
                    types: [domain.endpointType],
                },
                regionalCertificateArn: domain.certificateArn,
                securityPolicy: domain.securityPolicy,
            };
            if (domain.endpointType === Globals.endpointTypes.edge) {
                params.regionalCertificateArn = undefined;
            } else if (domain.endpointType === Globals.endpointTypes.regional) {
                params.certificateArn = undefined;
            }

            // Make API call to create domain
            try {
                // If creating REST api use v1 of api gateway, else use v2 for HTTP and Websocket
                createdDomain = await this.apigateway.createDomainName(params).promise();
            } catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw new Error(`Error: Failed to create custom domain ${domain.givenDomainName}\n`);
            }

        } else if (domain.apiType === "HTTP" || domain.apiType === "WEBSOCKET") {
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
                createdDomain = await this.apigatewayV2.createDomainName(params).promise();
                domain.domainInfo = new DomainInfo(createdDomain);

            } catch (err) {
                this.logIfDebug(err, domain.givenDomainName);
                throw new Error(`Error: Failed to create custom domain ${domain.givenDomainName}\n`);
            }
        }
    }

    /**
     * Delete Custom Domain Name through API Gateway
     */
    public async deleteCustomDomain(domain: DomainConfig): Promise<void> {
        const params = {
            domainName: domain.givenDomainName,
        };

        // Make API call
        try {
            await this.apigateway.deleteDomainName(params).promise();
        } catch (err) {
            this.logIfDebug(err, domain.givenDomainName);
            throw new Error(`Error: Failed to delete custom domain ${domain.givenDomainName}\n`);
        }
    }

    /**
     * Change A Alias record through Route53 based on given action
     * @param action: String descriptor of change to be made. Valid actions are ['UPSERT', 'DELETE']
     * @param domain: DomainInfo object containing info about custom domain
     */
    public async changeResourceRecordSet(action: string, domain: DomainConfig): Promise<void> {
        if (action !== "UPSERT" && action !== "DELETE") {
            throw new Error(`Error: Invalid action "${action}" when changing Route53 Record.
                Action must be either UPSERT or DELETE.\n`);
        }

        const createRoute53Record = domain.createRoute53Record;
        if (createRoute53Record !== undefined && createRoute53Record === false) {
            this.serverless.cli.log("Skipping creation of Route53 record.");
            return;
        }
        // Set up parameters
        const route53HostedZoneId = await this.getRoute53HostedZoneId(domain);
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
            await this.route53.changeResourceRecordSets(params).promise();
        } catch (err) {
            this.logIfDebug(err, domain.givenDomainName);
            throw new Error(`Error: Failed to ${action} A Alias for ${domain.givenDomainName}\n`);
        }
    }

    /**
     * Gets Route53 HostedZoneId from user or from AWS
     */
    public async getRoute53HostedZoneId(domain: DomainConfig): Promise<string> {
        if (domain.hostedZoneId) {
            this.serverless.cli.log(
                `Selected specific hostedZoneId ${this.serverless.service.custom.customDomain.hostedZoneId}`);
            return domain.hostedZoneId;
        }

        const filterZone = domain.hostedZonePrivate !== undefined;
        if (filterZone && domain.hostedZonePrivate) {
            this.serverless.cli.log("Filtering to only private zones.");
        } else if (filterZone && !domain.hostedZonePrivate) {
            this.serverless.cli.log("Filtering to only public zones.");
        }

        let hostedZoneData;
        const givenDomainNameReverse = domain.givenDomainName.split(".").reverse();

        try {
            hostedZoneData = await this.route53.listHostedZones({}).promise();
            const targetHostedZone = hostedZoneData.HostedZones
                .filter((hostedZone) => {
                    let hostedZoneName;
                    if (hostedZone.Name.endsWith(".")) {
                        hostedZoneName = hostedZone.Name.slice(0, -1);
                    } else {
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
        } catch (err) {
            this.logIfDebug(err, domain.givenDomainName);
            throw new Error(`Error: Unable to list hosted zones in Route53.\n${err}`);
        }
        throw new Error(`Error: Could not find hosted zone "${domain.givenDomainName}"`);
    }

    // public async getBasePathMapping(restApiId: string): Promise<string> {
    //     let basepathInfo;
    //     let currentBasePath;

    //     if (this.apiType === "REST") {
    //         const params = {
    //             domainName: this.givenDomainName,
    //         };
    //         try {
    //             basepathInfo = await this.apigateway.getBasePathMappings(params).promise();
    //         } catch (err) {
    //             this.logIfDebug(err);
    //             throw new Error(`Error: Unable to get BasePathMappings for ${this.givenDomainName}`);
    //         }
    //         if (basepathInfo.items !== undefined && basepathInfo.items instanceof Array) {
    //             for (const basepathObj of basepathInfo.items) {
    //                 if (basepathObj.restApiId === restApiId) {
    //                     currentBasePath = basepathObj.basePath;
    //                     break;
    //                 }
    //             }
    //         }
    //         return currentBasePath;

    //     } else if (this.apiType === "HTTP" || this.apiType === "WEBSOCKET") { // V2 HTTP and WEBSOCKET
    //         const params = {
    //             DomainName: this.givenDomainName,
    //         };
    //         try {
    //             basepathInfo = await this.apigatewayV2.getApiMappings(params).promise();
    //         } catch (err) {
    //             this.logIfDebug(err);
    //             throw new Error(`Error: Unable to get BasePathMappings for ${this.givenDomainName}`);
    //         }
    //         if (basepathInfo.Items !== undefined && basepathInfo.Items instanceof Array) {
    //             for (const basepathObj of basepathInfo.Items) {
    //                 if (basepathObj.ApiId === restApiId) {
    //                     currentBasePath = basepathObj.ApiMappingKey;
    //                     break;
    //                 }
    //             }
    //         }
    //         return currentBasePath;
    //     }
    // }

    /**
     * Creates basepath mapping
     */
    // public async createBasePathMapping(restApiId: string): Promise<void> {
    //     if (this.apiType === "REST") {
    //         const params = {
    //             basePath: this.basePath,
    //             domainName: this.givenDomainName,
    //             restApiId,
    //             stage: this.stage,
    //         };
    //         // Make API call
    //         try {
    //             await this.apigateway.createBasePathMapping(params).promise();
    //             this.serverless.cli.log("Created basepath mapping.");
    //         } catch (err) {
    //             this.logIfDebug(err);
    //             throw new Error(`Error: Unable to create basepath mapping.\n`);
    //         }

    //     } else if (this.apiType === "HTTP" || this.apiType === "WEBSOCKET") { // V2 HTTP and WEBSOCKET
    //         const params = {
    //             ApiId: restApiId,
    //             ApiMappingKey: this.basePath,
    //             DomainName: this.givenDomainName,
    //             Stage: this.apiType === "HTTP" ? "$default" : this.stage,
    //         };
    //         // Make API call
    //         try {
    //             await this.apigatewayV2.createApiMapping(params).promise();
    //             this.serverless.cli.log("Created basepath mapping.");
    //         } catch (err) {
    //             this.logIfDebug(err);
    //             throw new Error(`Error: Unable to create basepath mapping.\n`);
    //         }
    //     }
    // }

    /**
     * Updates basepath mapping
     */
    // public async updateBasePathMapping(oldBasePath: string): Promise<void> {
    //     const params = {
    //         basePath: oldBasePath,
    //         domainName: this.givenDomainName,
    //         patchOperations: [
    //             {
    //                 op: "replace",
    //                 path: "/basePath",
    //                 value: this.basePath,
    //             },
    //         ],
    //     };
    //     // Make API call
    //     try {
    //         await this.apigateway.updateBasePathMapping(params).promise();
    //         this.serverless.cli.log("Updated basepath mapping.");
    //     } catch (err) {
    //         this.logIfDebug(err);
    //         throw new Error(`Error: Unable to update basepath mapping.\n`);
    //     }
    // }

    /**
     * Gets rest API id from CloudFormation stack
     */
    // public async getApiId(): Promise<string> {
    //     if (this.serverless.service.provider.apiGateway && this.serverless.service.provider.apiGateway.restApiId) {
    //         this.serverless.cli.log(`Mapping custom domain to existing API
    //             ${this.serverless.service.provider.apiGateway.restApiId}.`);
    //         return this.serverless.service.provider.apiGateway.restApiId;
    //     }

    //     const stackName = this.serverless.service.provider.stackName ||
    //         `${this.serverless.service.service}-${this.stage}`;

    //     let LogicalResourceId = "ApiGatewayRestApi";
    //     if (this.apiType === "HTTP") {
    //         LogicalResourceId = "HttpApi";
    //     } else if (this.apiType === "WEBSOCKET") {
    //         LogicalResourceId = "WebsocketsApi";
    //     }

    //     const params = {
    //         LogicalResourceId,
    //         StackName: stackName,
    //     };

    //     let response;
    //     try {
    //         response = await this.cloudformation.describeStackResource(params).promise();
    //     } catch (err) {
    //         this.logIfDebug(err);
    //         throw new Error(`Error: Failed to find CloudFormation resources for ${this.givenDomainName}\n`);
    //     }

    //     const apiId = response.StackResourceDetail.PhysicalResourceId;
    //     if (!apiId) {
    //         throw new Error(`Error: No ApiId associated with CloudFormation stack ${stackName}`);
    //     }
    //     return apiId;
    // }

    /**
     * Deletes basepath mapping
     */
    // public async deleteBasePathMapping(): Promise<void> {
    //     const params = {
    //         basePath: this.basePath,
    //         domainName: this.givenDomainName,
    //     };
    //     // Make API call
    //     try {
    //         await this.apigateway.deleteBasePathMapping(params).promise();
    //         this.serverless.cli.log("Removed basepath mapping.");
    //     } catch (err) {
    //         this.logIfDebug(err);
    //         this.serverless.cli.log("Unable to remove basepath mapping.");
    //     }
    // }

    /**
     *  Adds the domain name and distribution domain name to the CloudFormation outputs
     */
    public addOutputs(domainInfo: DomainInfo): void {
        const service = this.serverless.service;
        if (!service.provider.compiledCloudFormationTemplate.Outputs) {
            service.provider.compiledCloudFormationTemplate.Outputs = {};
        }
        service.provider.compiledCloudFormationTemplate.Outputs.DomainName = {
            Value: domainInfo.domainName,
        };
        if (domainInfo.hostedZoneId) {
            service.provider.compiledCloudFormationTemplate.Outputs.HostedZoneId = {
                Value: domainInfo.hostedZoneId,
            };
        }
    }

    /**
     * Logs message if SLS_DEBUG is set
     * @param message message to be printed
     */
    public logIfDebug(message: any, domain: string): void {
        if (process.env.SLS_DEBUG || true) {
            this.serverless.cli.log(`${domain ? domain + ": " : ""} ${message}`, "Serverless Domain Manager");
        }
    }

    /**
     * Prints out a summary of all domain manager related info
     */
    // private printDomainSummary(domainInfo: DomainInfo): void {
    //     this.serverless.cli.consoleLog(chalk.yellow.underline("Serverless Domain Manager Summary"));

    //     if (this.serverless.service.custom.customDomain.createRoute53Record !== false) {
    //         this.serverless.cli.consoleLog(chalk.yellow("Domain Name"));
    //         this.serverless.cli.consoleLog(`  ${this.givenDomainName}`);
    //     }

    //     this.serverless.cli.consoleLog(chalk.yellow("Distribution Domain Name"));
    //     this.serverless.cli.consoleLog(`  Target Domain: ${domainInfo.domainName}`);
    //     this.serverless.cli.consoleLog(`  Hosted Zone Id: ${domainInfo.hostedZoneId}`);
    // }
}

export = ServerlessCustomDomain;
