import { track } from '../../lib/analytics';
track({ name: 'open', platform: 'extension', feature: 'agent' });
import { mountAgentSidePanel } from '../../components/agent/agent-side-panel';

mountAgentSidePanel('root', 'words');
