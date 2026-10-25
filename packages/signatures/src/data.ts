import type {
  AgentDomArtifact,
  AgentExtension,
  AutomationDefault,
  AutomationGlobalRule,
  BrowserHeaderProfile,
  HostedAgentProfile,
  HostingAsn,
  HostShape,
  HttpLibraryProfile,
  IpSource,
  SharedEgressList,
  WebBotAuthAbsence,
  WebBotAuthDirectory,
} from './types.js';
import httpLibrariesJson from '../data/fingerprints/http-libraries.json';
import browsersJson from '../data/fingerprints/browsers.json';
import directoriesJson from '../data/web-bot-auth/directories.json';
import absentJson from '../data/web-bot-auth/absent.json';
import hostingAsnsJson from '../data/network/hosting-asns.json';
import sharedEgressJson from '../data/network/shared-egress.json';
import hostedJson from '../data/hosted/hosted-agents.json';
import automationGlobalsJson from '../data/automation/globals.json';
import automationDomJson from '../data/automation/dom-artifacts.json';
import automationDefaultsJson from '../data/automation/defaults.json';
import extensionsJson from '../data/extensions/extensions.json';
import extensionDomJson from '../data/extensions/dom-artifacts.json';
import extensionGlobalsJson from '../data/extensions/globals.json';
import hostShapesJson from '../data/extensions/host-shapes.json';
import ipSourcesJson from '../data/ip-ranges/sources.json';

export const httpLibraryProfiles = httpLibrariesJson as unknown as HttpLibraryProfile[];
export const browserHeaderProfiles = browsersJson as unknown as BrowserHeaderProfile[];
export const webBotAuthDirectories = directoriesJson as unknown as WebBotAuthDirectory[];
/** Hosts probed for a key directory that had none (2026-10-24). */
export const webBotAuthAbsent = absentJson as unknown as WebBotAuthAbsence[];
export const hostingAsns = hostingAsnsJson as unknown as HostingAsn[];
export const sharedEgress = sharedEgressJson as unknown as SharedEgressList[];
export const hostedAgentProfiles = hostedJson as unknown as HostedAgentProfile[];
/** Main-world globals, document properties and stack/source markers of automation stacks and extension agents. */
export const automationGlobals = [
  ...(automationGlobalsJson as unknown as AutomationGlobalRule[]),
  ...(extensionGlobalsJson as unknown as AutomationGlobalRule[]),
];
/** DOM elements / attributes injected by automation frameworks and extension agents. */
export const agentDomArtifacts = [
  ...(automationDomJson as unknown as AgentDomArtifact[]),
  ...(extensionDomJson as unknown as AgentDomArtifact[]),
];
export const agentExtensions = extensionsJson as unknown as AgentExtension[];
export const agentHostShapes = hostShapesJson as unknown as HostShape[];
export const automationDefaults = automationDefaultsJson as unknown as AutomationDefault[];
/** Every IP range source (bundled and sync-time only); see data/ip-ranges/sources.json. */
export const ipSources = ipSourcesJson as unknown as IpSource[];
