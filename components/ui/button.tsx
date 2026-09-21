import type { ButtonHTMLAttributes } from 'react';
import {cva,type VariantProps} from 'class-variance-authority';
import {clsx} from 'clsx';
import {twMerge} from 'tailwind-merge';
const variants=cva('button',{variants:{variant:{default:'button-primary',outline:'button-outline',ghost:'button-ghost'},size:{default:'',sm:'button-sm',icon:'button-icon'}},defaultVariants:{variant:'default',size:'default'}});
export function Button({className,variant,size,...props}:ButtonHTMLAttributes<HTMLButtonElement>&VariantProps<typeof variants>) {return <button className={twMerge(clsx(variants({variant,size}),className))} {...props}/>;}
