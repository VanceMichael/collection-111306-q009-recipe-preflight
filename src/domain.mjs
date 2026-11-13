export function adapterSummary(adapters) {
 return Object.entries(adapters).map(([name,capability])=>({name,effect:capability.effect,replayable:capability.replayable}));
}
export function singleStep(recipe, adapters, seed) {
 if(recipe.steps.length!==1)throw new Error('预览器只支持单步');
 const step=recipe.steps[0];const adapter=adapters[step.adapter];if(!adapter)throw new Error('适配器未注册');
 return {step:step.id,output:adapter.output,seed};
}
export function preview(data) {return adapterSummary(data.adapters);}
